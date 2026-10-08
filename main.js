// CrewPane — Electron MAIN process.
//
// ADP-002 matures the ADP-001 terminal spike into a real app shell. The shell
// runs in one of three modes (CREWPANE_MODE, auto-detected when unset):
//
//   • dev   — spawn `next dev` as a child, wait for the port, loadURL(http://…).
//             Hot reload; default when running unpackaged.
//   • prod  — spawn the embedded standalone Next server (`.next/standalone/
//             server.js`) as a child, wait for the port, loadURL. Default when
//             packaged. This is ADP-001 approach #2: the real Next server runs
//             in-process-tree so every API route (focus-pane / reports) keeps
//             working unchanged — no static export, `src/` untouched.
//   • spike — load the isolated ADP-001 renderer (xterm.js + node-pty) and, under
//             AUTOTEST, run the pty round-trip regression so the terminal
//             capability proven in ADP-001 stays green.
//
// Security (carried from ADP-001, unchanged): contextIsolation:true,
// nodeIntegration:false, sandbox:true, whitelisted preload bridge.


const { app, BrowserWindow, ipcMain, shell, dialog, screen, globalShortcut, Notification, protocol, net: electronNet, clipboard, nativeImage } = require('electron');

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto'); // ADP-293 — mobil query requestId'leri
const { spawn, execFile } = require('node:child_process');
const pty = require('node-pty');

const instancePaths = require('./src/config/instancePaths.cjs');
const supabaseTarget = require('./src/config/supabaseTarget.cjs'); // ADP-305 — test instance → e2e DB (kablo: encode/decodeArgv)
const backendTarget = require('./src/config/backendTarget.cjs'); // ADP-621 — kanal bazlı uygulama DB hedefi
const publicBackendEnv = require('./src/config/publicBackendEnv.cjs');
const appDbIdentity = require('./src/config/appDbIdentity.cjs'); // ADP-622 — app DB'ye hangi KİMLİKLE bağlanılır
const mixedTargetGuard = require('./src/config/mixedTargetGuard.cjs'); // ENV-01 — kimlik ↔ app DB karışımının reddi
const crewpaneEnv = require('./src/config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — env ikizleri (tek türetme noktası)
const envProfileModule = require('./src/config/envProfile.cjs');
const singleInstanceLock = require('./src/core/singleInstanceLock.cjs');
const deepLinkArgv = require('./src/services/deepLinkArgv.cjs');
const { renameWithRetrySync } = require('./platform/atomicWrite.cjs');
const safeStorageIdentity = require('./src/security/safeStorageIdentity.cjs');
const schemeOwnership = require('./src/core/schemeOwnership.cjs'); // ADP-719

// ── Bootstrap (Faz 3.1): Erken adımların sırayla çalıştırılması ──────────────
const { runBootstrap } = require('./src/main/bootstrap/index.js');
const { createWindowManager } = require('./src/main/windows');
const { registerSystemIpc } = require('./src/features/system');
const { registerPopoutIpc } = require('./src/features/popout');
const { registerDesignIpc } = require('./src/features/design');
const { registerSpritesIpc } = require('./src/features/sprites');
const { registerOfficeIpc } = require('./src/features/office');
const { registerResourceIpc } = require('./src/features/resource');
const { registerUpdateIpc } = require('./src/features/update');
const {
  registerWorktreeIpc,
  registerBrowserIpc,
  registerIntegIpc,
  registerSprintIpc,
} = require('./src/features/services');
const { registerMemoryIpc } = require('./src/features/memory');
const { registerHandIpc } = require('./src/features/hand');
const { registerSyncIpc } = require('./src/features/sync');
const { registerMobileIpc } = require('./src/features/mobile');
const {
  registerEngineIpc,
  registerEngineAuthIpc,
  registerEngineProfilesIpc,
} = require('./src/features/auth');
const {
  registerSkillsIpc,
  registerAgentxIpc,
  registerAgentxDraftIpc,
  registerDelegationIpc,
} = require('./src/features/agents');
const { registerPtyIpc } = require('./src/features/terminal');
const { registerVoiceIpc } = require('./src/features/voice');
let windowManager = null;

const bootstrapCtx = {
  app,
  dialog,
  argv: process.argv,
  cwd: process.cwd(),
  handleFocusWindow: (record) => {
    try {
      consumeArgvDeepLink(record && record.argv, 'focus-request');
    } catch (e) {
      try { process.stderr.write(`[single-instance] deep-link error: ${e.message}\n`); } catch { /* ignore */ }
    }
    try {
      let win = appWindow;
      if (!win || win.isDestroyed()) {
        if (!appBaseUrl) {
          process.stderr.write('[single-instance] odak isteği geldi ama pencere henüz yok (açılış sürüyor)\n');
          return;
        }
        logLine('[single-instance] odak isteği: ana pencere kapalıydı — yeniden açılıyor');
        createAppWindow(appBaseUrl);
        win = appWindow;
        if (!win || win.isDestroyed()) return;
      }
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      try { win.flashFrame(true); } catch { /* best-effort */ }
    } catch (e) {
      try { process.stderr.write(`[single-instance] focus error: ${e.message}\n`); } catch { /* ignore */ }
    }
  },
};

runBootstrap(bootstrapCtx);

const ENV_PROFILE = bootstrapCtx.envProfile;
const singleInstanceGate = bootstrapCtx.singleInstanceGate;
const singleInstanceEarlyLog = bootstrapCtx.singleInstanceEarlyLog;
const SAFE_STORAGE_SCOPE = bootstrapCtx.safeStorageScope;
const SHELL_COMMIT = bootstrapCtx.shellCommit;
// ADP-013 — agent runner core: command whitelist (RCE guard), spawn validation,
// status derivation. Pure/Electron-free so it is unit-tested separately
// (electron/agentRunner.test.cjs). See ADR-002.
const agentRunner = require('./src/agents/agentRunner.js');
// ADP-050 (ADR-004 §A1) — leader→app delegation bridge (loopback HTTP + token).
const delegationBridgeMod = require('./src/agents/delegationBridge.js');
// ADP-324 — pane çıktısının VT emülasyonu (mobil okuma kanalı). Bkz. paneScreen.cjs başlığı.
const paneScreen = require('./src/terminal/paneScreen.cjs');
const browserCdp = require('./src/services/browserCdp.js'); // ADP-095 — headed automation (CDP)
const browserGateMod = require('./src/security/browserGate.cjs'); // ADP-341 — risk kapısı (izin + audit + DURDUR)
const browserTrustMod = require('./src/security/browserTrust.cjs'); // ADP-343 — yerleşik güven/yasak listeleri (Ayarlar salt-okunur gösterir)
const demoSitePath = require('./src/config/demoSitePath.cjs'); // DEMO-04 — tanıtım turunun örnek sitesinin yol boğazı
const jarvisVoice = require('./src/voice/jarvisVoice.js'); // ADP-121 (ADR-009) — voice core (STT/brain/TTS)
const grokVoice = require('./src/voice/grokVoice.cjs'); // ADP-827 (Faz 7) — Grok Voice SEÇENEĞİ (ücretli, opt-in)
const tmuxWindows = require('./src/terminal/tmuxWindows.cjs'); // ADP-136 — department → tmux window auto-switch
const livePaneRegistry = require('./src/agents/livePaneRegistry.cjs'); // ADP-192 — restart-resume registry
const agentEngineMirror = require('./src/agents/agentEngineMirror.cjs'); // HATA-12 — ajanın GÜNCEL motoru + sürüklenme hükmü
const engineCoerce = require('./src/agents/engineCoerce.cjs'); // ENG-05 — motor değeri kapısı (bilinmeyen → null + log)
const engineRegistry = require('./src/agents/engineRegistry.cjs'); // ENG-04/07 — motor descriptor defteri (reset komutu + yetenek beyanı)
const paneCapabilityMatrix = require('./src/terminal/paneCapabilityMatrix.cjs'); // ENG-10 — descriptor beyanı → kullanıcı-yüzü yetenek matrisi (rozetler)
const engineLeadership = require('./src/agents/engineLeadership.cjs'); // ENG-19 — lider-uygunluk (yetenek matrisinden TÜRETİLİR, motor adına bakmaz)
const enginePlanned = require('./src/agents/enginePlanned.cjs'); // ENG-HONEST-CARD-01 — "yolda" etiketinin tek kaynağı (planlı board kartı haritası)
const engineDelegation = require('./src/agents/engineDelegation.cjs'); // ENG-17/ENG-21 — delegasyon vatandaşlığı ("bu motora İŞ VERİLEBİLİR Mİ")
const engineOffering = require('./src/agents/engineOffering.cjs'); // ENG-21 — "sunulsun mu" hükmü (migration seed aynası, drift testli)
const paneSessionsJournal = require('./src/terminal/paneSessionsJournal.cjs'); // ADP-734 Kapı 3 — silinmeyen oturum defteri
const modelDetect = require('./src/agents/modelDetect.cjs'); // ADP-526 — pane model chip (K1 spawn-anı + K2 çıktı teyidi)
const providers = require('./src/agents/providers.cjs'); // ADP-580 — codex custom AI providers (Groq/DeepSeek/Kimi)
const modelCatalog = require('./src/agents/modelCatalog.cjs'); // AGENT-MODEL-01 — motor başına model kataloğu (tek kaynak)
const adapter = require('./src/config/adapter.cjs'); // ADP-594 — Responses→ChatCompletions adapter for DeepSeek/Kimi (needsShim:true)
const groqShim = require('./src/voice/groqResponsesShim.cjs'); // PROV-01 — Groq /responses gövde temizleyici + kota hız-ayarı
const providerKeysEnvFile = require('./src/config/providerKeysEnvFile.cjs'); // PROV-01 — ~/.crewpane/keys.env → providerKeys yedeği
const helperReaper = require('./src/core/helperReaper.cjs'); // ADP-727 — yardımcı süreç defteri + yetim toplayıcı
const installReset = require('./src/security/installReset.cjs'); // RESET-01 — kurulum sıfırlama ÇEKİRDEĞİ (tek silme boğazı)
const resetGate = require('./src/security/resetGate.cjs'); // RESET-03 — sıfırlamanın KARAR katmanı (saf; birim testli)
const quitFunnel = require('./src/core/quitFunnel.cjs'); // HATA-14 — tek kapanış hunisi (karar + fren + adım sırası)
const paneKill = require('./src/terminal/paneKill.cjs'); // TASK-MRDXOGZJDQLJG — quit-aware explicit pane kill
const resumePtyDaemon = require('./src/terminal/resumePtyDaemon.cjs'); // ADP-limit (ADR-007 Faz 4) — in-app pty auto-resume
const agentSettings = require('./src/agents/agentSettings.cjs'); // ADP-203 — user settings (~/.crewpane/settings.json)
const appI18n = require('./i18n/index.cjs'); // ADP-888 — ana sürecin ARAYÜZ DİLİ katmanı (diyalog/bildirim metinleri)
const updateCheck = require('./src/services/updateCheck.cjs'); // ADP-533 — Faz 1 güncelleme bildirimi (yalnız bildir + tarayıcıda indir)
const onboardingStore = require('./src/agents/onboardingStore.cjs'); // TOUR-02-A — "İlk 10 Dakika" günlüğünün kalıcılığı (yerel + taşınabilir tercih)
const announcements = require('./src/services/announcements.cjs'); // ADP-675 — uygulama-içi duyuru feed'i (normalize + hedefleme)
const changelogFeed = require('./src/services/changelogFeed.cjs'); // A-10 — uygulama-içi "Yenilikler" paneli (crewpane.dev/changelog.json)
const updateChannel = require('./src/services/updateChannel.cjs'); // ADP-620 — yayın kanalı (stable=müşteri | beta=önce biz)
const reportsWatcher = require('./src/services/reportsWatcher.cjs'); // ADP-298 — rapor dizinleri değişince renderer'a olay
const memoryGraph = require('./src/memory/memoryGraph.cjs'); // ADP-243 — in-app Memory view graph provider
const skillCenter = require('./src/agents/skillCenter.cjs'); // SK-03 — Skill Merkezi'nin SALT OKUNUR liste/detay katmanı
const skillApprove = require('./src/agents/skillApprove.cjs'); // SK-04 — taslak→yayın (insan onayı; TEK mutasyon noktası)
const skillAuthor = require('./src/agents/skillAuthor.cjs'); // SK-05 — kullanıcının yazma ucu (yeni/düzenle → HER ZAMAN taslak)
const skillEngineView = require('./src/agents/skillEngineView.cjs'); // SK-03 — motor görünümü + kapı nöbetçisi (R8/T6)
const skillEngineSync = require('./src/agents/skillEngineSync.cjs'); // SKL-B0 — eşitleme TETİĞİ (açılış/kök değişimi/elle) + durum özeti
const skillVersions = require('./src/agents/skillVersions.cjs'); // SK-08 — yayın geçmişi (kim/ne zaman/ne değişti)
const skillShare = require('./src/agents/skillShare.cjs'); // SK-08 — dışa/içe aktarım (içe aktarım HER ZAMAN taslağa)
const skillGuard = require('./src/agents/skillGuard.cjs'); // SK-08 — onay damgası denetimi + yazma-yolu nöbetçisi
const builtinSkills = require('./src/agents/builtinSkills.cjs'); // SKL-B6 — gömülü katalog → kanonik depo KURULUM boğazı
const memoryIndexService = require('./src/memory/memoryIndexService.cjs'); // ADP-870 — hafıza RAG indeksi (arka plan çocuk süreç)
const searchIndexService = require('./src/memory/searchIndexService.cjs'); // SEARCH-2 — genel arama indeksi (rapor/hafıza/görev/oturum)
const memorySearchService = require('./src/memory/memorySearchService.cjs'); // ADP-871 — hibrit arama (kelime + anlam)
const memoryEmbedInstall = require('./src/memory/memoryEmbedInstall.cjs'); // ADP-900 — ONAYLI gömme motoru kurulumu
const memoryEmbedder = require('./src/memory/memoryEmbedder.cjs'); // ADP-870 — gömme motorunun kullanılabilirlik raporu
const memoryEmbedHosted = require('./src/memory/memoryEmbedHosted.cjs'); // WIN-W6A — yerel motor yokken barındırılan gömme + kasa köprüsü
const memoryRecall = require('./src/memory/memoryRecall.cjs'); // ADP-862 — arama UCU (kaynak+alıntı, maskeli, uydurmasız) + bağlam seçici
const memoryTaskBlock = require('./src/memory/memoryTaskBlock.cjs'); // D-07 — AŞAMA B: göreve-göre seçki (sorgu = iş metni)
const engineMemoryScope = require('./src/agents/engineMemoryScope.cjs'); // MEM-SCOPE-01 — MOTORUN indeksi için aynı iki aşama
const paneContextScope = require('./src/terminal/paneContextScope.cjs'); // MEM-SCOPE-01 — motorun hafıza indeksinin yolu (tek kaynak)
const codeIntel = require('./src/services/codeIntel.cjs'); // ADP-206 — editor git-diff + file list + grep
const localSprites = require('./src/agents/localSprites.cjs'); // ADP-736 — ~/.crewpane/sprites (paket-dışı kişisel avatarlar)
const sprintStore = require('./src/agents/sprintStore.cjs'); // ADP-242 — uzun-sprint run kalıcılığı (sprint-runs/)
const crewpanePaths = require('./src/config/crewpanePaths.cjs'); // ADP-233 — <workspace>/.crewpane/{tasks,results} yol sözleşmesi
const transcriptProbe = require('./src/services/transcriptProbe.cjs'); // ADP-280 — teslim-doğrulama transcript probu
const codexRolloutProbe = require('./src/mcp/codexRolloutProbe.cjs'); // ENG-02 — aynı probun codex defteri (rollout) dalı
const paneTokenBudget = require('./src/terminal/paneTokenBudget.cjs'); // TOKEN-BUDGET-01 — pane sabit yükü (kalibre tahmin)
const tokenUsage = require('./src/services/tokenUsage.cjs'); // ADP-887 — pane'in jeton/maliyet ölçümü (motor defterleri)
const tokenCost = require('./src/services/tokenCost.cjs'); // TOK-A/B — fiyat + ölçüm sabitlerinin TEK kaynağı (modelPricing.json)
// ADP-705 — pane⇄oturum çapası. `/clear` claude'da YENİ bir oturum (yeni uuid, yeni
// jsonl) açar ve bunu bize SÖYLEMEZ; pty defterindeki `--session-id` o an BAYAT olur.
// Bayat id ile okunan transcript "prompt yok" der → GERÇEKTEN ÇALIŞAN worker
// `undelivered` YALANIYLA öldürülürdü (2026-07-28'in beş vakasının ölçülmüş kök nedeni).
const paneSessionAnchor = require('./src/terminal/paneSessionAnchor.cjs');
const taskClaim = require('./src/agents/taskClaim.cjs'); // ADP-896 — aynı ajan+görev için ikiz pane kapısı
// B-01 (GIT-BACKBONE-SPEC) — görev ↔ branch ↔ proje omurgası (izole worktree).
const taskCodeMod = require('./src/agents/taskCode.cjs');
const worktreeStore = require('./src/services/worktreeStore.cjs');
const worktreeService = require('./src/services/worktreeService.cjs');
const projectRepos = require('./src/config/projectRepos.cjs');
const branchName = require('./src/config/branchName.cjs'); // GIT-BB-CLOUD-01 — varsayılan dal doğrulaması (git ref grameri)
const codeIndexStore = require('./src/services/codeIndex.cjs'); // CIDX-1 — kod indeksi ayarı (şema + ikili keşfi + tazelik)
const codeIndexHealth = require('./src/services/codeIndexHealth.cjs'); // CODEINDEX-PROOF-01 — sağlık: araca SOR, deftere güvenme
const mergeService = require('./src/services/mergeService.cjs');
const delegationQueueStore = require('./src/agents/delegationQueueStore.cjs'); // QUEUE-PERSIST — kuyruk+paused kalıcılığı
// ADP-659 — OTOPILOT SÜREKLİLİĞİ: uçuştaki delegasyonların MAIN-side kalıcı gözcüsü.
// Renderer'ın motoru (delegation.ts) efemerdir — reload/crash'te tüm nöbetleri ölür ve
// uçuştaki alt-görev hiçbir yerde kalıcı DEĞİLDİR (queue store yalnız queued+paused tutar).
// Bu ikili o boşluğu kapatır: defter diskte, tespit main'de, kuyruk lider olmadan ilerler.
const delegationSupervisorMod = require('./src/agents/delegationSupervisor.cjs');
const delegationSupervisorStore = require('./src/agents/delegationSupervisorStore.cjs');
// SUP-UI-01 — KUYRUK PANELİ. Yeni defter YOK: üç mevcut defteri (queue/supervisor/
// resume) + canlı pane listesini TEK tabloya çeviren SAF çekirdek. Metin taşımaz,
// yalnız kod döndürür (cümleyi renderer i18n'den kurar).
const queueBoard = require('./src/agents/queueBoard.cjs');
// SUP-UI-01 — limit-devam kuyruğunun deposu (ADP-087). Panel bu defteri de OKUR;
// yazan taraf hâlâ resume daemon'ıdır (bu dosyada tek çağrı `loadQueue`/`queuePath`).
const resumeQueueStore = require('./src/terminal/resumeQueue.cjs');
const boardTaskSyncMod = require('./src/agents/boardTaskSync.cjs'); // ADP-838 — supervisor → Task Board statü senkronu
// ADP-715/845 — TELEMETRİ. İki ayrı iş, TEK opt-out kapısı:
//   telemetry.cjs → hata takibi (Sentry). ADP-845 K1: DSN/SDK YOK, yani bugün
//     `{enabled:false}` döner — ama kablo ARTIK DOĞRU DOSYADA. (ADP-805 §2.2'de
//     ölçüldü: init çağrısı silinmiş kök main.js'teydi, paketlenen giriş noktası
//     burasıydı → yayındaki üründe sıfır telemetri.)
//   heartbeat.cjs → "kim, hangi sürümde, ne zaman aktifti" (kendi Supabase'imiz).
const telemetryMod = require('./telemetry/telemetry.cjs');
const heartbeatMod = require('./telemetry/heartbeat.cjs');
const telemetryChannelMod = require('./telemetry/channel.cjs'); // build kanalı (prod|dev|test) TEK GERÇEK
// OBS-02 — hata takibi TEK YOLU (main+renderer+worker → Sentry). Mevcut moduleFault
// yoluna takılan bir musluktur; ikinci bir yakalama ağı DEĞİL (bkz. errorReporter.cjs).
const errorReporter = require('./telemetry/errorReporter.cjs');
// SEN-F2 — pane çıkışı gürültü/arıza ayrımı (SEN-01 §4.4). Saf karar, ayrı dosyada: testli.
const paneExitClassifier = require('./telemetry/paneExit.cjs');
// OBS-01 — ÜRÜN ANALİTİĞİ TEK YOLU (aktivasyon hunisi · panel kullanımı · plan
// limiti redleri → PostHog). OBS-02 ile AYNI gizlilik sözleşmesi, AYNI kanal/
// anahtar çözümü, AYNI kapatma anahtarı; ölçüm noktaları da YENİ DEĞİL — mevcut
// `telemetryBump` ve `pushPlanLimit` musluklarına takılır (bkz. analytics.cjs).
const analyticsMod = require('./telemetry/analytics.cjs');
// SEC-W1-C1 — kurcalama sinyalleri (saf ölçüm; muslukları aşağıda bağlanır).
const tamperSignals = require('./src/security/tamperSignals.cjs');
const integrityCheck = require('./src/security/integrityCheck.cjs');

// ─── SEC-W2-A2 — PAKET BÜTÜNLÜK RAPORU (TEK SEFER, TEMBEL) ──────────────────
//
// TEMBEL BİLEREK: ölçüm bu makinede 324 dosya + 27,6 MB asar için ~440 ms
// sürüyor. Açılış yoluna binmemesi için ilk kez lisans jetonu tazelenirken
// (zaten eşzamansız, açılıştan SONRA) hesaplanır ve bir daha hesaplanmaz —
// paketin dosyaları uygulama açıkken değişmez.
//
// TELEMETRİ DE BURADAN ÇIKAR: "ölçtüm" ile "raporladım" tek yerde kalsın diye.
// İkisi ayrı yerlerde olsaydı, biri koşup diğeri koşmadığında kaç kopyanın
// kurcalandığı sorusu sessizce yanlış cevaplanırdı.
let integrityReportCache = null;
function integrityReportOnce() {
  if (integrityReportCache) return integrityReportCache;
  let report;
  try {
    report = integrityCheck.run({
      packagedBaked: instancePaths.packagedBuild(),
      bakedBuild: instancePaths.bakedBuildType(),
      // `buildChannel` bu dosyada DAHA AŞAĞIDA bağlanıyor (const, TDZ). Bu
      // fonksiyon tembel çağrıldığı için bugün sorun çıkmaz — ama sırayı bir
      // gün değiştiren kişiye bu bağımlılığı bırakmamak için burada alınır.
      customerBuild: require('./src/config/buildChannel.cjs').isCustomerBuild(),
      // Paketli uygulamada `Resources` burasıdır; paketsiz koşuda kalkan zaten
      // ilk koşulda (packagedBuild !== true) devreye girer ve buraya gelinmez.
      resources: process.resourcesPath || null,
    });
  } catch (e) {
    // Ölçüm arızası bir BULGU DEĞİLDİR: rapor gönderilmez, zorlama olmaz.
    logLine(`integrity: ölçüm atlandı (${e && e.message})`);
    report = { status: integrityCheck.STATUS.SKIPPED, reason: 'measure_failed', jws: null, root: null };
  }
  integrityReportCache = report;

  if (report.status === integrityCheck.STATUS.MISMATCH) {
    const file = integrityCheck.primaryFile(report);
    logLine(`integrity: AYRIŞMA — değişen=${report.changed.length} eksik=${report.missing.length} `
      + `eklenen=${report.added.length} (${report.durationMs} ms)`);
    // SEC-W1-C1 şeması: kapalı küme `reason`, YALNIZ dosya ADI, PII yok.
    // `signature` hâlâ 'unknown' — ölçtüğümüz şey MANİFEST imzasıdır, paketin
    // işletim sistemi imzası değil; ölçmediğimizi 'valid' yazmak yalan olurdu.
    const event = { reason: tamperSignals.REASONS.UNPACKED_HASH_MISMATCH, signature: 'unknown' };
    if (file) event.file = file;
    try { analyticsNow().track('tamper', event); } catch { /* analitik hata üretmez */ }
    try {
      obsReporterNow().capture({
        surface: 'main',
        module: 'tamper',
        label: event.reason,
        message: `paket bütünlüğü tutarsız: ${event.reason}`,
        level: 'warning',
        tamper: true,
      });
    } catch { /* hata takibi hata üretmez */ }
  } else if (report.status === integrityCheck.STATUS.OK) {
    logLine(`integrity: paket doğrulandı (${report.durationMs} ms)`);
  } else {
    logLine(`integrity: denetim koşmadı (${report.reason})`);
  }
  return integrityReportCache;
}
const analyticsSchema = require('./telemetry/analyticsSchema.cjs');
// INT-OBS-01 — tek jetondan otomatik kurulum (org bul → proje aç → anahtar çek →
// kanal başına yaz → doğrulama olayı) + sonucun şifreli defteri.
const provisionStoreMod = require('./telemetry/provisionStore.cjs');
const telemetryProvisionMod = require('./telemetry/telemetryProvision.cjs');
// ADP-692 — KANAL A: liderin tur-başı brifingi (UserPromptSubmit hook'u makbuz bırakır,
// supervisor tüketir → aynı bitiş bir de composer'a YAZILMAZ).
const leaderBriefing = require('./src/agents/leaderBriefing.cjs');
// ADP-692 — enjeksiyon kapısı (insan varlığı + composer hükmü); `pty:writeGuarded` bunu
// main'de, yazımla AYNI senkron blokta koşturur → araya tuş basımı GİREMEZ.
const leaderComposer = require('./src/agents/leaderComposer.cjs');
// LDR-F1 — LİDER TAZELEME KAPISI (saf çekirdek: kip · soğuma · backoff · rozet hükmü ·
// geri-yükleme metni). Karar YENİDEN ÜRETİLMEZ: `dispatchPolicy.decide` ne diyorsa odur,
// bu modül yalnız "o karar liderde ŞU AN uygulanabilir mi" sorusunu cevaplar (LDR-R1 §5).
const leaderRefreshPolicy = require('./src/agents/leaderRefreshPolicy.cjs');
// LDR-F1 — lider rol slug'larının TEK KAYNAĞI (agentRunner + renderer ile AYNI dosya).
const leaderRole = require('./src/agents/leaderRole.cjs');
// ENT-F1 — ana sürecin TESLİM-DOĞRULAMALI yazım primitifi. ENT-R1 §3 ölçtü:
// `writePromptToPane` (devir özeti) ve `/clear` dizisi metni yazıp 400 ms sonra
// `\r` basıyor ve HİÇBİR ŞEY doğrulamıyordu — canlı log'da 22 sıfırlamanın 4'ü
// "TUTMAMIŞ". Aynı primitif supervisor'ın iki yolunu da besliyor (tek uygulama).
const { createDeliverPrompt } = require('./src/agents/deliverPrompt.cjs');
// AXP-03 — Agent X'ten ajana prompt teslimi + makbuz (deliverToPane + transcript probu üstüne).
const agentxDeliverMod = require('./src/agents/agentxDeliver.cjs');
const agentxBeamMod = require('./src/agents/agentxBeam.cjs');
const paneAskMod = require('./src/terminal/paneAsk.cjs'); // ASK-CARD-01 — liderin karar sorusu → kart + "cevap bekliyor"
const inputSim = require('./src/services/inputSim.cjs'); // ADP-265 — Jarvis input-sim çekirdeği (şema+sınır+rate-limit)
const screenCaptureMod = require('./src/services/screenCapture.cjs'); // ADP-817 — screen.capture çekirdeği (şema+yakalama+dürüst hata)
const stdioGuard = require('./src/core/stdioGuard.cjs'); // ADP-303 — EPIPE/dead-stream guard (no crash dialog)
const notifyLog = require('./src/services/notifyLog.cjs'); // ADP-538 — in-app worker completion → .agent-notifications DONE/FAIL satırı
const notifyGateMod = require('./src/services/notifyGate.cjs'); // ADP-667 — bildirim tekilleştirme + toplama (TEK boğaz)
const notifyPathMod = require('./src/services/notifyPath.cjs'); // ADP-545 — notify-log yolu: dev + packaged tek aday-probe (lider tail hedefi)
const evidencePathMod = require('./src/services/evidencePath.cjs'); // ADP-735 — kanıt yolu: çok-adaylı kök çözümü (worker alt-projeye yazar)
const resultRootMod = require('./src/services/resultRoot.cjs'); // RES-IDX-01 — sonuç kökü görevin PROJESİNDEN (prompt + supervisor aynı cevabı alır)
const moduleGuard = require('./src/agents/moduleGuard.cjs'); // ADP-335 — modül hata sınırı (bir bug uygulamayı çökertmesin)
const paneControl = require('./src/terminal/paneControl.cjs'); // ADP-303 — lider pane kontrolü (kapsam + öz-koruma)
const teamScope = require('./src/agents/teamScope.cjs'); // ADP-717 — takım kapsamı: delege + yönetim TEK karar
const teamComposeCore = require('./src/agents/teamCompose.cjs'); // TC-01 — takım kurucu: rol süzgeci, tavanlar, onay jetonu, geri alma günlüğü
const workspaceOnboarding = require('./src/agents/workspaceOnboarding.cjs'); // ADP-232-C — ilk-açılış "çalışma alanı seç" çekirdeği
const workspaceSwitch = require('./src/agents/workspaceSwitch.cjs'); // ADP-232-B — canlı çalışma alanı geçişi (grandfather) çekirdeği
const engineCheck = require('./src/agents/engineCheck.cjs'); // ADP-463-B — setup sihirbazı motor/CLI probu (uyarı-only)
const engineInstall = require('./src/agents/engineInstall.cjs'); // ADP-694 — motor CLI kurulum rehberi + spawn ön-kontrolü
const spawnPromptFile = require('./src/agents/spawnPromptFile.cjs'); // AD-WIN-01 — kimliği komut satırından çıkar (Windows)
const cmdLineLimit = require('./platform/cmdLineLimit.cjs'); // AD-WIN-01 — komut satırı uzunluk kapısı
const winShellPrereq = require('./platform/winShellPrereq.cjs'); // WIN-FIRSTRUN-01 K1 — Windows'ta motorun kabuk ön koşulu (claude kapısının aynası)
const opencodeModelGate = require('./src/agents/opencodeModelGate.cjs'); // ENG-OPENCODE-PROVIDER-01 — model ön-doğrulama kapısı (olmayan model sessizce buluta DÜŞMEZ)
const paneEarlyExit = require('./src/terminal/paneEarlyExit.cjs'); // WIN-FIRSTRUN-01 K2 — açılışta ölen pane'in hücresi kapanmaz
const ptyResizeGate = require('./src/terminal/ptyResizeGate.cjs'); // WIN-FIRSTRUN-01 K3 — ölü pty'ye resize gitmez (PROD-48)
const guestPermissions = require('./platform/guestPermissions.cjs'); // WIN-FIX-01 (W5) — iç tarayıcı izin politikası
const engineAuth = require('./src/agents/engineAuth.cjs'); // ADP-597 — abonelikle giriş (claude/codex oturumu Ayarlar'dan)
const engineBilling = require('./src/agents/engineBilling.cjs'); // ENG-16 — satıcı-barındırılan bedava kapı (fatura şeffaflığı + spawn kapısı)
const engineProfiles = require('./src/agents/engineProfiles.cjs'); // ADP-936 — AI motoru HESAP profilleri (çok-hesap geçişi)
const engineSwitch = require('./src/agents/engineSwitch.cjs'); // ACCT-FIX-01 — limit defteri okuma ("Bu hesaba geç" listesi: hangi pane limitte)
const limitDetect = require('./src/terminal/limitDetect.cjs'); // ACCT-FIX-01 — pane ekranında limit var mı (aynı algılayıcı, resume daemon ile)
const engineLoginLedger = require('./src/agents/engineLoginLedger.cjs'); // ENG-F4-01 — "burada giriş yapıldı" kaydı (durum komutu olmayan motorlar)
const engineCatalog = require('./src/agents/engineCatalog.cjs'); // ADP-915 — yetenek→motor kaydı + "fatura kime çıkar" anlık görüntüsü
const presetAdvisor = require('./src/agents/presetAdvisor.cjs'); // B-06 — onboarding şablon önerisi (model + katalog doğrulaması)
const firstRunDoctor = require('./src/agents/firstRunDoctor.cjs'); // ADP-625 — ilk açılış sağlık kontrolü (ADP-616 §5.4)
// LX-SAFESTORAGE-01 — sır arka ucunun TEK boğazı (ölç → hüküm → üç yüzey).
const secretBackendState = require('./src/security/secretBackendState.cjs');
const crashWatchdog = require('./src/core/crashWatchdog.cjs'); // ADP-475 — crash instrumentation + render-process-gone recovery core
const crashJournal = require('./src/core/crashJournal.cjs'); // CRASH-R1 — kapanış defteri (sebep + zaman + sinyal), açılışta geri okunur
const logTarget = require('./src/services/logTarget.cjs'); // CRASH-R1 — izole kopya (duman/e2e) KENDİ günlüğüne yazar
const nextServerPolicy = require('./src/config/nextServerPolicy.cjs'); // SMOKE-ISO-01 — Next beklenmedik ölürse: 1 kez kaldır, sonra kapat
const popoutBounds = require('./src/services/popoutBounds.cjs'); // ADP-593 — pane pop-out pencere konum/boyut defteri
const jarvisWidget = require('./src/voice/jarvisWidget.cjs'); // ADP-816 — taşınabilir ses widget'ı (saf karar katmanı)
const handOverlayContract = require('./src/hand/handOverlayContract.cjs'); // HAND-A1 — el kontrolü overlay sözleşmesi (saf karar katmanı)
const paneBudget = require('./src/terminal/paneBudget.cjs'); // TOK-C — bütçe kararının SAF çekirdeği
const paneBudgetStore = require('./src/terminal/paneBudgetStore.cjs'); // TOK-C — pane bütçesi + otomatik duraklatma defteri
const spendGuard = require('./src/security/spendGuard.cjs'); // TOK-C (D-02 v2) — "bu yazım parayı harcar mı, bütçe izin veriyor mu"
const dispatchPolicy = require('./src/agents/dispatchPolicy.cjs'); // TOK-B (D-03) — "sürdür mü, taze oturum mu" kararının SAF çekirdeği
const paneViewState = require('./src/terminal/paneViewState.cjs'); // ADP-712 — pane görünüm durumu (okunabilir mod) pencereler arası tek gerçek
const paneDraft = require('./src/terminal/paneDraft.cjs'); // ADP-786 — gönderilmemiş prompt taslağı pencereler/mod arası tek gerçek
const agentxDraft = require('./src/agents/agentxDraft.cjs'); // AXP-02 — Agent X iş taslağı (duraksama göndermez, teyit sesli) — paneDraft kardeşi
const clipboardHistoryCore = require('./src/services/clipboardHistory.cjs'); // ADP-935 — pano geçmişi çekirdeği (gizlilik kapısı + halka tampon)
const tempImageStore = require('./src/services/tempImageStore.cjs'); // WIN-IMG-01 — ajana giden geçici görsellerin OTURUM-kapsamlı ömrü (TTL yarışı yok)
const attachmentStoreMod = require('./src/services/attachmentStore.cjs'); // BOARD-IMG-2 — görev kartı ekleri: içerik-adresli, KALICI depo (TTL yok)
// FDBK-01 — uygulama içi geri bildirim formunun main ucu: maskelenmiş log kesiti +
// AgentShot son çekimleri. Salt-okunur ve dar kapsamlı (bkz. feedbackBridge.cjs).
const feedbackBridgeMod = require('./src/services/feedbackBridge.cjs');
const clipboardImageRoute = require('./src/services/clipboardImageRoute.cjs'); // WIN-IMG-01 — pano görüntüsü pane'e nasıl iner (PLATFORM × motor)
// ─── ADP-584/585/586 — Entegrasyon Merkezi (Dalga 0) ─────────────────────────
const integrationCatalog = require('./src/mcp/integrationCatalog.cjs'); // ADP-584/588 — servis şablonları (tek kaynak)
const credentialGate = require('./src/security/requireCredential.cjs'); // ADP-628 — anahtar çözümlemesinin TEK boğazı
const { createCredentialVault } = require('./src/security/credentialVault.cjs'); // ADP-584 — şifreli anahtar deposu
const { createIntegrationResolver } = require('./src/mcp/integrationResolver.cjs'); // ADP-585 — spawn-anı çözümleme
const { buildIntegrationsStatus } = require('./src/mcp/integrationStatus.cjs'); // BR-01 — ajanın keşif cevabı
const { createIntegrationIpc } = require('./src/mcp/integrationIpc.cjs'); // ADP-586 — IPC sınırı (doğrulama + maske)
// MCP-COST-01 — MCP cocuk sureclerinin envanteri + yetim bicmesi (ORPHAN-ELECTRON-01
// cekirdegini CAGIRIR, yeniden yazmaz) ve "otomatik acilmasin" isareti.
const mcpProcess = require('./src/mcp/mcpProcess.cjs');
const integrationAutostart = require('./src/mcp/integrationAutostart.cjs');
const { createSecretRedactor } = require('./src/security/secretRedactor.cjs'); // ADP-586 — log/ekran/notify maskeleme
const mcpProbe = require('./src/mcp/mcpProbe.cjs'); // ADP-586 — "bağlantıyı test et" (gerçek MCP handshake)

// ADP-586 — SIR MASKELEME DEFTERİ. Süreç ömrü boyunca tek örnek; `logLine`, pane
// çıktısı, transcript IPC'leri ve notify yazımı buradan geçer. Defter yalnız iki
// yerden dolar: (a) kullanıcı Ayarlar'dan anahtar eklediğinde, (b) bir pane spawn'ı
// entegrasyon anahtarı çözümlediğinde (plan.env taraması) — yani sır enjekte edilen
// her yol maskeleme kapsamına girer. Defter BOŞKEN redact() girdiyi aynen döndürür.
const secretRedactor = createSecretRedactor({ mask: integrationCatalog.maskSecret });

const REPO_ROOT = (fs.existsSync(path.join(__dirname, 'package.json')) && fs.existsSync(path.join(__dirname, 'standalone')))
  ? __dirname
  : path.join(__dirname, '..');
// ADP-202/203 — where AGENT panes spawn (cwd) + the file-tree root. The PACKAGED app's
// REPO_ROOT points INSIDE the bundle (app.asar), so a delegated worker landed in
// /Applications/.../Resources and couldn't see the real project (the ADP-187 dogfood
// cwd bug). settings.workspaceRoot (or CREWPANE_WORKSPACE_ROOT env) repoints agent
// spawns + the workspace file API at the user's real checkout.
// ADP-232-C — the PACKAGED fallback is now NULL, never the bundle: an unconfigured
// packaged install used to resolve to /Applications/.../Resources (read-only, wrong)
// and every consumer silently mis-rooted. Null → the renderer shows the first-run
// "çalışma alanı seç" gate (WorkspaceGate) and root-needing paths fail with a CLEAR
// workspace_not_configured error instead. Source-run dev keeps the REPO_ROOT fallback.
// ADP-232-B — the ACTIVE agent workspace root. `let`, not `const`: switchWorkspaceRoot()
// below reassigns it LIVE (no app restart) when the user picks a new workspace in
// Settings. Every consumer reads this binding at call time (spawn cwd, file bridge,
// memory/results dirs, git diff), so a reassignment takes effect on the NEXT call —
// while already-open panes + running workers keep their old root (grandfathered via
// `activeRoots`, so their file/git access still resolves). The ONE process-lifetime
// binding that does NOT live-switch is the embedded Next server's env
// (CREWPANE_WORKSPACE_ROOT below) — it is spawned once and its child env is immutable.
// ADP-852 — TEST DİKİŞİ (ürün davranışını DEĞİŞTİRMEZ): `FORCE_FIRST_RUN=1`
// zaten "paketli ilk açılış gibi davran" anlamına geliyordu (workspaceOnboarding.
// firstRunRequired aynı bayrağı okur), ama KÖK ÇÖZÜMÜ bu bayrağa KÖR idi: kaynaktan
// koşan e2e her zaman REPO_ROOT'a düşüyordu, yani müşterinin YAŞADIĞI durum
// (agentWorkspaceRoot === null) kaynaktan HİÇ test edilemiyordu. Bayrak yalnız
// yapılandırılmış kök YOKKEN etkili (aşağıdaki `resolveWorkspaceRoot` sırası:
// env → settings → fallback) — kök seçildikten sonra davranış birebir aynıdır.
const FORCE_FIRST_RUN = crewpaneEnv.readEnv('FORCE_FIRST_RUN') === '1';
let agentWorkspaceRoot = agentSettings.resolveWorkspaceRoot(
  app.isPackaged || FORCE_FIRST_RUN ? null : REPO_ROOT,
);

// ADP-201 — the office Task Board MCP (crewpane-task-mcp.cjs) reads
// NEXT_PUBLIC_CREWPANE_SUPABASE_{URL,ANON_KEY} from its env. The PACKAGED app launches from
// /Applications with a minimal launchd env and ships no .env.local (gitignored, dev-only), so
// those vars are absent → the board MCP reports "Supabase not configured" (the renderer is fine:
// NEXT_PUBLIC_* are inlined at build time). This resolves the two PUBLIC vars (the anon key is the
// RLS-protected client key — safe to hand an agent) from, in order: process.env → REPO_ROOT/
// .env.local (dev) → ~/.crewpane/crewpane-public-env.json (packaged; written from .env.local).
// Cached; returns {} when none found (board just stays unconfigured — no crash).
let _publicSupabaseEnvCache = null;
// ADP-723 — publicSupabaseEnv()'in verdiği KARARIN tamamı (kanal + kaçış izleri +
// customerBuild). Rozet/doktor bunu okur; aynı kararı ikinci kez türetmek iki gerçeğe
// yol açar (bu bug'ın kökü zaten "ekranda hangi kanaldayım yazmıyordu"ydu).
let _lastBackendTarget = null;
function publicSupabaseEnv() {
  if (_publicSupabaseEnvCache) return _publicSupabaseEnvCache;
  const URL_K = 'NEXT_PUBLIC_CREWPANE_SUPABASE_URL';
  const ANON_K = 'NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY';
  // ADP-621 — hedefle birlikte seyahat eden schema (bulut: 'app', yerel/e2e: 'public').
  const SCHEMA_K = 'NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA';
  const out = {};
  // CFG-01 — ÜÇ KADEMELİ "live" okuması artık publicBackendEnv.cjs'te (process.env →
  // <repoRoot>/.env.local → ~/.crewpane/crewpane-public-env.json). Buradan taşındı
  // çünkü AYRI SÜREÇLER (task MCP) main'in çözümlemesini miras alamıyor ve kendi
  // yarım kopyalarını yazıyorlardı — ödeyen bir müşteri tam bu yüzden görev panosunu
  // hiç kullanamadı. Karar tek yerde: aynı `live`, aynı `resolveBackendTarget`.
  const live = publicBackendEnv.readLivePair({ repoRoot: REPO_ROOT });
  if (live.url) out[URL_K] = live.url;
  if (live.anonKey) out[ANON_K] = live.anonKey;

  // ADP-621 — KANAL, üç kademeli çözümlemenin ÜSTÜNDE karar verir (electron/backendTarget.cjs):
  //   prod → BULUT crewpane-id (`app` schema) · dev → yerel 54321 · test → e2e 55321.
  // Bu, her Node tarafı tüketicinin (board MCP, agentRunner) zaten geçtiği TEK boğazdır;
  // aynı hedef sharedWebPreferences() ile renderer'a da verilir — derleme-zamanı gömülü
  // NEXT_PUBLIC_* değerlerini ezmenin TEK yolu odur.
  // FAIL-CLOSED: prod kanalında loopback hedef reddedilir (müşteride "Failed to fetch" +
  // boş ofis bug'ı — ADP-616 §5.2 — yapısal olarak imkânsız olur).
  // ADP-305 sözleşmesi korunur: test kanalı her koşulda e2e stack'ine gider.
  const target = backendTarget.resolveBackendTarget(process.env, instancePaths.instanceId(), {
    url: out[URL_K],
    anonKey: out[ANON_K],
    // ENV-01 — ŞEMA DA TAŞINIR. `readLivePair` bunu zaten çözüyordu ama buraya hiç
    // gelmiyordu; `resolveBackendTarget` de URL'den TAHMİN ediyordu → tek-stack yerel
    // kurulumda (56321 + `app`) her istek `public`e gidip 404 dönüyordu (ENV-R2 vaka B2).
    schema: live.schema,
  });
  _lastBackendTarget = target; // ADP-723 — kanal rozeti bu KARARI okur, ikinci kez türetmez
  if (target.url && target.anonKey) {
    out[URL_K] = target.url;
    out[ANON_K] = target.anonKey;
    // Bulut projede uygulama tabloları `public`te DEĞİL, `app` schema'sında. Schema
    // hedefle birlikte taşınmazsa istemci yanlış schema'yı sorgular (404).
    out[SCHEMA_K] = target.schema;
  } else if (target.isE2E && target.keyMissing) {
    // ADP-741 — TEST kanalında anahtar çözülemedi. Buradan sessizce geçmek `out`u
    // .env.local'dan gelen CANLI çiftle (ADP-723/728 sonrası BULUT) bırakır, yani
    // test kopyası ÜRETİM veritabanına bağlanırdı — ADP-305 sözleşmesinin tam tersi.
    // Hedefi e2e stack'inde SABİTLE, anahtar yerine konuşan bir sentinel koy: istemci
    // yalnızca 55321'e gider, oradan 401 alır ve sebebi hem log'da hem ağ isteğinde
    // okunur. Sessiz yanlış-hedef yerine gürültülü doğru-hedef.
    out[URL_K] = target.url;
    out[ANON_K] = 'CREWPANE_E2E_ANON_KEY_MISSING';
    out[SCHEMA_K] = target.schema;
    logLine(
      `⛔ [backend] ADP-741 — e2e anon anahtarı YOK (${target.keyMissing}). Hedef ${target.url} olarak ` +
      `sabitlendi ama istekler 401 alacak. Çözüm: CREWPANE_E2E_SUPABASE_ANON_KEY ver ` +
      // ADP-748: bu ipucu ESKİDEN bir `require('…')` çağrısını METİN olarak taşıyordu ve
      // require-grafiği kapısı (scripts/verify_asar_requires.cjs) onu GERÇEK bir require
      // sanıp yayını kırdı (kapı regex'tir; string/yorum bağlamı bilmez). İpucu artık
      // modülü ADRESLE tarif eder — bilgi aynı, kapı yanlış alarm vermez.
      `(anahtarı e2e/e2eAnonKey.cjs → resolveE2EAnonKey() çözer) ya da npm run e2e:db:start.`
    );
  }
  for (const r of target.rejected) {
    logLine(`[backend] ${target.instance} kanalında YEREL hedef reddedildi (${r.reason}): ${r.url} → ${target.url}`);
  }
  // ADP-780-B — paketli DEV build'in hedefi çözülemediyse SESSİZ KALMA: bu durumda
  // kimlik PROD buluta düşer ve dev'de açılan hesap GERÇEK müşteri tablosuna girer.
  // (Bir kez yaşandı: hedef JSON'u `build.files` kalıplarına uymadığı için asar'a
  // hiç girmemişti ve app hiçbir şey söylemeden prod projeye bağlandı.)
  try {
    const devWarn = require('./src/config/devChannel.cjs').misconfigurationWarning();
    if (devWarn) logLine(devWarn);
  } catch (e) { logLine(`[dev-kanal] uyarı üretilemedi: ${e.message}`); }

  _publicSupabaseEnvCache = out[URL_K] && out[ANON_K] ? out : {};
  return _publicSupabaseEnvCache;
}

// ADP-622 — app DB'ye KİM olarak bağlanıyoruz? Karar saf modülde (appDbIdentity.cjs):
// jeton YALNIZCA onu imzalayan projeye takılır. Bulut (auth == app DB, ADP-621 kararı)
// → 'crewpane-id'; yerel 54321 / e2e 55321 → 'anon' (bugünkü davranış birebir).
let _appDbIdentityLogged = null;
function appDbIdentityMode() {
  const decision = appDbIdentity.resolveIdentityMode({
    authUrl: crewpaneIdConfig(process.env).supabaseUrl,
    dbUrl: publicSupabaseEnv().NEXT_PUBLIC_CREWPANE_SUPABASE_URL,
  });
  const line = `${decision.mode}/${decision.reason}/${decision.project || '-'}`;
  if (_appDbIdentityLogged !== line) {
    _appDbIdentityLogged = line;
    logLine(`[appdb] kimlik modu=${decision.mode} (${decision.reason}) hedef=${decision.project || '-'}`);
  }
  return decision;
}

/**
 * ADP-622/773 — app DB için TAZE kullanıcı jetonu. TEK KARAR NOKTASI.
 *
 * Üç yüzey (renderer `appdb:token` IPC'si · delegasyon köprüsü `/app-db/token` ·
 * mobil ofis) aynı cevabı vermek ZORUNDA: kimlik ayrışırsa bir yüzey okur diğeri
 * 401 alır ve bu "telefonda bozuk, Mac'te çalışıyor" olarak görünür (ADP-773 vakası).
 *
 * `ok:false` bir hata değil bir DURUM: çağıran anon'a düşer (yerel/e2e stack'lerde
 * kimlik zaten yoktur ve `public` şeması anon'a açıktır).
 *
 * @param {string} action  seat kapısının denetlediği eylem adı
 */
// INC-20260917-02 — SON EMNİYET KEMERİ. Kapının kendisi (desktopAuth) artık 10sn'de
// zaman aşımına uğruyor; buradaki üst sınır ONUN ÖTESİ içindir: Keychain kilidi,
// safeStorage IO'su ya da ileride eklenecek bir çağrı asılırsa `appdb:token` IPC'si
// renderer'ı açılışta SONSUZA kadar bekletmesin. Bu bir hata değil bir DURUM:
// çağıran anon'a düşer (appDbTokenFor sözleşmesi).
const APPDB_TOKEN_TIMEOUT_MS = 12_000;

async function appDbTokenFor(action) {
  const decision = appDbIdentityMode();
  if (decision.mode !== 'crewpane-id') return { ok: false, reason: decision.reason };
  if (!seatGate) return { ok: false, reason: 'not_ready' };
  // ADP-646 — kimlik lisansa bağlı: paketsiz kullanıcıya jeton verilmez.
  const denied = seatDenial(action);
  if (denied) return { ok: false, reason: denied.reason, message: denied.message };
  let timer = null;
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error(`appdb token ${APPDB_TOKEN_TIMEOUT_MS}ms içinde dönmedi`);
        e.name = 'TimeoutError';
        reject(e);
      }, APPDB_TOKEN_TIMEOUT_MS); // unref YOK: kurtarma zamanlayıcısı, finally'de temizlenir
    });
    const p = seatGate.accessToken();
    p.catch(() => {}); // yarışı süre kazanırsa geç gelen hata "unhandled" olmasın
    return await Promise.race([p, deadline]);
  } catch (e) {
    if (e && e.name === 'TimeoutError') {
      logLine(`appdb token timeout (${action}) — anon'a düşülüyor`);
      return { ok: false, reason: 'timeout' };
    }
    logLine(`appdb token error (${action}): ${e.message}`); // jetonun KENDİSİ asla loglanmaz
    return { ok: false, reason: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** ADP-773 — mobil ofisin kimliği; masaüstü/ajan yüzeyleriyle AYNI kapıdan geçer. */
const mobileAppDbToken = () => appDbTokenFor('mobile:/m/office');

// ENV-01 Faz 3 — karışım kararı TEK KEZ verilir ve HER YÜZEY onu okur (rozet ikinci kez
// türetmesin — `_lastBackendTarget` deseninin aynısı, ADP-723).
let _mixedTargetDecision = null;

/**
 * ENV-02 — DÖRT KATMANIN TEK GÖRÜNTÜSÜ (profil · şema · app DB · kimlik · giriş · posta).
 *
 * ⛔ İKİNCİ KEZ TÜREME YASAĞI: açılış banner'ı, doktorun "ortam" bölümü ve arayüz
 * rozeti AYNI nesneyi okur. Üç yüzey aynı soruyu üç kez sorarsa üç gerçek doğar —
 * ADP-723'ün rozeti tam bu yüzden `window.crewpaneDb`yi okur, kendi çözümlemesini
 * yapmaz. `mixed` alanı da burada ÜRETİLMEZ; `_mixedTargetDecision`den okunur.
 *
 * @returns {{profile:string|null, channel:string, scheme:string, dbUrl:string|null,
 *            dbSchema:string|null, authUrl:string|null, loginUrl:string|null,
 *            mailUrl:string|null, customerBuild:boolean,
 *            mixed:{level:string, reason:string, message:string|null}|null}}
 */
function envLayerView() {
  const idCfg = crewpaneIdConfig(process.env);
  const dbEnv = publicSupabaseEnv();
  return {
    profile: ENV_PROFILE.name,
    channel: _lastBackendTarget ? _lastBackendTarget.instance : instancePaths.instanceId(),
    scheme: APP_URL_SCHEME,
    dbUrl: dbEnv.NEXT_PUBLIC_CREWPANE_SUPABASE_URL || null,
    dbSchema: dbEnv.NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA || null,
    authUrl: idCfg.supabaseUrl || null,
    loginUrl: idCfg.loginUrl || null,
    // Yalnız `local` profilinde anlamlı: giden e-posta yok, kodlar Mailpit'e düşer.
    mailUrl: ENV_PROFILE.name === 'local' ? envProfileModule.LOCAL_MAILPIT_URL : null,
    customerBuild: !!idCfg.customerBuild,
    mixed: _mixedTargetDecision
      ? {
        level: _mixedTargetDecision.level,
        reason: _mixedTargetDecision.reason,
        message: _mixedTargetDecision.message || null,
      }
      : null,
  };
}

/**
 * ENV-01 Faz 2 madde 6 — AÇILIŞ BANNER'I + Faz 3 KARIŞIM KAPISI.
 *
 * Bugüne kadar `main.js:534` yalnız `[appdb] kimlik modu=…` basıyordu; `crewpaneIdConfig`in
 * SEÇTİĞİ `supabaseUrl`/`loginUrl` hiçbir log satırında geçmiyordu (grep: 0 sonuç).
 * "Neden fark edilmedi"nin cevabı buydu — dört katman artık TEK SATIRDA yazıyor.
 *
 * `block` ⇒ açılış DURUR (exit 1). Uyarı denendi ve işe yaramadı: `devChannel`in
 * "Bu kopyayla KAYIT OLMA" satırı log'a düşüyordu ve olay yine yaşandı (ADP-780-B).
 *
 * @returns {{level: string, reason: string}} karar (test/inceleme için)
 */
function logEnvBannerAndGuard() {
  const view = envLayerView();
  const idCfg = crewpaneIdConfig(process.env);
  const dbUrl = view.dbUrl;

  logLine(envProfileModule.bootBannerLine(view));
  if (ENV_PROFILE.overridden.length) {
    logLine(`[env] profil EZİLDİ (kabuktaki açık env kazandı): ${ENV_PROFILE.overridden.join(', ')}`);
  }
  for (const r of ENV_PROFILE.rejected) {
    logLine(`[env] kaçış yok sayıldı (${r.reason}): ${r.key}`);
  }

  const decision = mixedTargetGuard.checkMixedTargets({
    authUrl: idCfg.supabaseUrl,
    dbUrl,
    loginUrl: idCfg.loginUrl,
    instanceId: instancePaths.instanceId(),
    allowMixed: mixedTargetGuard.truthy(process.env[mixedTargetGuard.ALLOW_MIXED_KEY]),
    customerBuild: !!idCfg.customerBuild,
  });
  _mixedTargetDecision = decision;
  if (decision.level === 'warn' && decision.message) logLine(`[env] ${decision.message}`);
  if (decision.level === 'block') {
    logLine(decision.message);
    // ⚠️ MODAL YALNIZ PAKETLİ KOPYADA. `dialog.showErrorBox` main thread'i BLOKLAR ve
    // kimse tıklamazsa süreç sonsuza kadar asılı kalır — kaynaktan koşuda (terminal,
    // e2e harness'ı, CI) bu, "kapı çalıştı" ile "kapı kilitlendi"yi ayırt edilemez
    // yapar (ölçüldü: T4'ün ilk koşusu SIGTERM'e kadar asıldı). Paketli kopyada
    // terminal YOKTUR, kart tek görünür yüzeydir; kaynakta kart zaten yukarıdaki
    // `logLine` ile terminale ve dosya log'una basılmış durumda.
    if (app.isPackaged) {
      try { dialog.showErrorBox('CrewPane — ortam karışımı', decision.message); } catch { /* headless */ }
    }
    app.exit(1);
  }
  return decision;
}

/** The {url, anonKey, schema} the RENDERER must use — same resolution as publicSupabaseEnv(). */
function rendererSupabaseTarget() {
  const env = publicSupabaseEnv();
  const envView = envLayerView();
  return {
    url: env.NEXT_PUBLIC_CREWPANE_SUPABASE_URL,
    anonKey: env.NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY,
    schema: env.NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA,
    // ADP-622 — 'crewpane-id' ise renderer istemcisi her isteğe kullanıcının JWT'sini
    // takar (oturum yoksa anon key'e düşer). Alan YOKSA istemci bugünkü gibi kurulur.
    auth: appDbIdentityMode().mode === 'crewpane-id' ? 'crewpane-id' : undefined,
    isE2E: instancePaths.instanceId() === 'test',
    // ADP-723 — KANAL ROZETİ: renderer "hangi kopyadayım + hangi veri kaynağına
    // bağlıyım" sorusunu tahmin etmesin. `channel` backendTarget'ın ÇÖZDÜĞÜ kanaldır
    // (müşteri build'inde env ile 'dev' denilse bile 'prod'), yani ekranda yazan şey
    // ile gerçek hedef aynı karardan gelir.
    channel: _lastBackendTarget ? _lastBackendTarget.instance : instancePaths.instanceId(),
    customerBuild: _lastBackendTarget ? !!_lastBackendTarget.customerBuild : undefined,
    // ENV-01 Faz 3 — SARI ROZET: karışım kararı burada ÜRETİLMEZ, okunur. Renderer
    // "kimlik ile app DB ayrı mı?" sorusunu ikinci kez türetirse iki gerçek doğar.
    mixed: _mixedTargetDecision && _mixedTargetDecision.level === 'warn'
      ? { reason: _mixedTargetDecision.reason, message: _mixedTargetDecision.message }
      : undefined,
    // ENV-02 — ORTAM ROZETİ: dört katman + Mailpit adresi. Renderer hiçbirini
    // TÜRETMEZ (kimlik/giriş adresleri renderer'a bugüne kadar HİÇ ulaşmıyordu:
    // ekranda yalnız app DB yazıyordu, yani "hangi kimlik sunucusundayım" sorusunun
    // cevabı arayüzde YOKTU). Anon anahtarlar bu görüntüde YER ALMAZ.
    env: {
      profile: envView.profile,
      scheme: envView.scheme,
      dbUrl: envView.dbUrl,
      dbSchema: envView.dbSchema,
      authUrl: envView.authUrl,
      loginUrl: envView.loginUrl,
      mailUrl: envView.mailUrl,
    },
  };
}

/**
 * ADP-625 — İlk açılış doktorunu ÇALIŞTIR (tek yer: hem IPC hem açılış logu).
 *
 * Doktora verdiğimiz her şey OKUNUR bir görüntüdür — ADP-621 hedef çözümlemesinin
 * mantığına dokunmaz, yalnız sonucunu yoklar. `seatGate` henüz kurulmamışsa hesap
 * anlık görüntüsü `null`dır (doktor bunu "okunamadı" olarak, ⚠️ ile raporlar).
 */
/**
 * ADP-907 — YABANCI KANCA taramasının GİRDİLERİ (salt-okunur).
 *
 * `hookScanHome()` kullanıcının GERÇEK ev dizinidir (`~/.claude/settings.json` orada
 * yaşar) — `crewpaneHome()` DEĞİL: o, instance köküne bakan ayrı bir karardır.
 * `HOOK_SCAN_HOME`/`HOOK_SCAN_PATH` yalnız TEST SEAM'idir (CREWPANE_TMUX_BIN deseni):
 * e2e, gerçek ev dizinine ve gerçek PATH'e hiç dokunmadan üç durumu da (var / yok /
 * ölçemedim) kurabilsin diye. Üründe ikisi de tanımsızdır → os.homedir() + process.env.
 */
function hookScanHome() {
  const seam = crewpaneEnv.readEnv('HOOK_SCAN_HOME');
  return typeof seam === 'string' && seam ? seam : os.homedir();
}
function hookProbeEnv() {
  // BİLEREK ham okuma (crewpaneEnv.readEnv DEĞİL): readEnv boş dizeyi "yok" sayar,
  // burada BOŞ ('') anlamlı bir değerdir — "PATH yok" → prob `unknown` der ve kart
  // ÇIKMAZ. Kapının üçüncü vakası (ölçemedim) ancak böyle kurulabilir.
  const raw = process.env.CREWPANE_HOOK_SCAN_PATH;
  return typeof raw === 'string' ? { ...process.env, PATH: raw } : process.env;
}

async function runDoctorNow() {
  let account = null;
  try {
    account = seatGate ? seatGate.evaluate() : null;
  } catch { account = null; }
  return firstRunDoctor.runFirstRunDoctor({
    // ADP-907 — başka bir aracın kurduğu, bu makinede ÇALIŞAMAYAN kancalar.
    userHome: hookScanHome(),
    env: hookProbeEnv(),
    home: instancePaths.crewpaneHome(),
    // ADP-703 — `auth/` CİHAZ kökünde yaşar (hesabı o blob'lar belirler → hesap
    // kökünün içinde olamazdı). Diğer klasörler hesap kökünde kalır.
    deviceHome: instancePaths.instanceHome(),
    backend: rendererSupabaseTarget(),
    // ENV-02 — doktorun "ortam" bölümü. Görüntü BURADA türetilmez: banner ve rozetle
    // AYNI `envLayerView()` okunur (üç yüzey / tek gerçek).
    envView: envLayerView(),
    identityMode: appDbIdentityMode().mode,
    account,
    checkEngines: () => engineCheck.checkEngines(),
    workspaceRoot: agentWorkspaceRoot,
    // ADP-852 v3 — "seçilmedi" ile "seçildi ama erişilemiyor"u ayırt edebilmesi için
    // doctor'a çözülmüş kökün YANINDA seçilen kökü + tutmama sebebini de ver.
    workspaceStatus: agentSettings.configuredWorkspaceRootStatus(),
    // LX-SAFESTORAGE-01 — doktor ÖLÇMEZ, açılışta ölçüleni OKUR (ikinci bir
    // safeStorage sorgusu ikinci bir gerçek üretirdi).
    secretBackend: secretBackendState.secretBackendState(),
  });
}

// ADP-192 — restart-resume. Auto re-spawn the running agent panes on the next
// launch (unattended — see [[autopilot-auto-resume]]). Kill-switch: set
// CREWPANE_DISABLE_RESTORE=1. CREWPANE_HOME is a TEST SEAM (same spirit as
// CREWPANE_TMUX_BIN / CREWPANE_EXTERNAL_URL): it relocates ~/.crewpane so the
// e2e fixture can drive a real restart→resume on an isolated registry file.
const RESTORE_DISABLED = process.env.CREWPANE_DISABLE_RESTORE === '1';
// ═══════════════════════════════════════════════════════════════════════════
// ENG-10 — YETENEK MATRİSİNİN DEFTERİ (+ e2e SAHTE-MOTOR DİKİŞİ)
// ═══════════════════════════════════════════════════════════════════════════
// Rozetlerin ÜÇ hâlini (tam / kısmi / yok) gerçek bir kısıtlı motor beklemeden
// ölçebilmek için defter enjekte edilebilir olmalı. Dikiş ENG-08'in AUTH dikişiyle
// AYNI disiplindedir ve aynı env adlarını kullanır (ikinci bir bayrak icat etmek
// iki ayrı "test modu" demek olurdu):
//   • açık opt-in bayrağı ŞART (ambient env tek başına yetmez),
//   • gelen her kayıt ürünün KENDİ şemasından geçer (`validateRegistry`) — geçmeyen
//     kayıt YÜKLENMEZ (fail-closed): test kendi hayalini değil ürünün sözleşmesini
//     doğrular,
//   • gerçek motor kayıtlarının ÜSTÜNE yazmaz, YANINA eklenir.
function capabilityRegistry() {
  const env = process.env;
  if (env.CREWPANE_FAKE_ENGINE_DESCRIPTORS !== '1') return engineRegistry;
  let raw = null;
  try { raw = JSON.parse(String(env.CREWPANE_FAKE_ENGINE_DESCRIPTORS_JSON || '{}')); } catch { return engineRegistry; }
  if (!raw || typeof raw !== 'object') return engineRegistry;
  const map = {};
  for (const id of engineRegistry.engineIds()) map[id] = engineRegistry.getEngine(id);
  let added = 0;
  for (const [id, d] of Object.entries(raw)) {
    if (!d || typeof d !== 'object' || map[id]) continue; // gerçek kaydı EZMEZ
    const verdict = engineRegistry.validateRegistry({ [id]: d });
    if (!verdict || verdict.ok !== true) {
      const errs = (verdict && verdict.errors && verdict.errors[id]) || [];
      logLine(`engine:capabilityMatrix fake descriptor REDDEDİLDİ id=${id} errors=${errs.length}: ${errs.slice(0, 3).join(' · ')}`);
      continue;
    }
    map[id] = d;
    added += 1;
  }
  if (!added) return engineRegistry;
  logLine(`engine:capabilityMatrix fake descriptors loaded count=${added}`);
  return engineRegistry.createRegistry(map);
}

function crewpaneHome() {
  return process.env.CREWPANE_HOME || os.homedir();
}
let panesRestored = false; // restore runs once per process (first window load)
/**
 * PLAN-FIX-01 (F-4) — plan tavanı yüzünden AÇILMAYAN restore pane'lerinin SÜREÇ
 * ÖMÜRLÜ sayacı. Log satırı tek başına kanıt olarak zayıftır (kaynaktan koşan
 * ikinci bir kopya aynı dosyayı döndürebilir); bu sayaç ürünün KENDİ durumudur.
 */
let restoreSkippedByPlan = 0;

// ADP-limit (ADR-007 Faz 4) — in-app pty auto-resume. Default ON + LIVE
// ([[autopilot-auto-resume]]; the ADP-192 default-on/kill-switch precedent).
// Kill-switch CREWPANE_DISABLE_AUTORESUME=1; CREWPANE_RESUME_DRYRUN=1 observes
// but never touches a pane.
const AUTORESUME_DISABLED = process.env.CREWPANE_DISABLE_AUTORESUME === '1';
// LIMIT-RESUME-02 — kontrol kolu: `CREWPANE_LIMIT_RESUME_02=0` bugünkü davranışı
// (ESC yoklaması + reset'te kör gönderim) geri getirir. Varsayılan AÇIK: claude ≥ 2.1.270
// pane'lerinde motor kendi devam eder, daemon yalnız nöbetçidir.
const LIMIT_RESUME_02 = process.env.CREWPANE_LIMIT_RESUME_02 !== '0';
// LIMIT-RESUME-02 — makinedeki claude ikilisinin sürümü (transcript sürümü okunamayan
// pane için yedek). Bir kez, ASENKRON, önbellekli: main sürecini bloke etmez; cevap
// gelene dek `null` = "bilinmiyor" (bugünkü yol), yani hiçbir pane'e yanlış mod verilmez.
let claudeCliVersionCache = null;
function probeClaudeCliVersion() {
  try {
    execFile('claude', ['--version'], { timeout: 8000, windowsHide: true }, (err, stdout) => {
      if (err) return;
      const m = String(stdout || '').match(/\d+\.\d+\.\d+/);
      if (m) claudeCliVersionCache = m[0];
    });
  } catch {
    /* PATH'te claude yok → yedek yok */
  }
}
let ptyResumeDaemon = null; // started once, after the first restoreLivePanes
const AUTOTEST = process.env.CREWPANE_SPIKE_AUTOTEST === '1';

// HATA-14 — TEK FREN, TEK DURUM. `app.quit()` KİBAR bir istektir (ADP-876);
// bu fren onu ARTIK HER kapanış yolunda bağlar (eskiden yalnız hesap değiştirme
// yolunda vardı — DISC-TRIAGE-03 §4.9-b). Tek seferliktir: art arda gelen quit
// denemeleri üst üste zamanlayıcı yığmaz. `unref` → hızlı kapanışı geciktirmez.
//
// 5000 ms KEYFİ DEĞİL: ADP-876'nın hesap yolunda ölçülmüş değeriyle AYNI ve
// kapanış hunisindeki en uzun adımın (next-server nezaket penceresi, 3000 ms —
// stopNextServer) üstünde kalır; yani fren normal kapanışı ASLA kesmez.
const QUIT_BRAKE_MS = 5000;
const quitBrakeState = {};
function armQuitBrake(label) {
  return quitFunnel.armForceExit(quitBrakeState, {
    ms: QUIT_BRAKE_MS,
    log: logLine,
    exit: (code) => app.exit(code),
    label,
  });
}

// ---------------------------------------------------------------------------
// CRASH-R1 — KAPANIŞ SEBEBİ: quit'i KİM istedi?
// ---------------------------------------------------------------------------
// 16.09 01:39'da uygulama Eren yokken kapandı. Ölçüm net: DIŞARIDAN sinyal
// GELMEDİ (SIGTERM dinleyicisi hiç tetiklenmedi), jetsam/çökme kaydı YOK ve
// launchd çıkışı `(0, 0, 0)` — yani süreç kendi `before-quit` yolunu koşarak
// TEMİZ kapandı. Demek ki `app.quit()` süreç İÇİNDEN çağrıldı; ama HANGİ çağrı
// olduğu hiçbir yere yazılmıyordu ve ~15 ayrı `app.quit()` çağrı yeri var.
//
// `noteQuit` o boşluğu kapatır: her çağrı yeri sebebini İŞARETLER, `before-quit`
// bunu deftere yazar ve bir sonraki açılış ilk satırlarda gösterir. İlk işaret
// KAZANIR — kapanış zinciri ilerlerken sebep 'unknown'a EZİLMEZ.
let quitReason = null;
let quitSignal = null;
function noteQuit(reason, signal) {
  if (quitReason) return quitReason; // ilk sebep gerçek sebeptir
  quitReason = reason || 'unknown';
  if (signal) quitSignal = signal;
  try { logLine(`[crash-r1] kapanış sebebi: ${quitReason}${signal ? ` (${signal})` : ''}`); } catch { /* log tutmaz */ }
  return quitReason;
}
const APP_STARTED_AT = Date.now();
let quitJournalWritten = false;
app.on('before-quit', () => {
  if (quitJournalWritten) return; // quit birden çok kez tetiklenebilir
  quitJournalWritten = true;
  try {
    crashJournal.record(instancePaths.instanceHome(crewpaneHome()), {
      reason: quitReason || 'user-quit', // işaretlenmemiş quit = kullanıcı yolu (Cmd+Q / pencere)
      signal: quitSignal,
      uptimeMs: Date.now() - APP_STARTED_AT,
      rssBytes: process.memoryUsage().rss,
      panes: ptys.size,
      version: app.getVersion(),
      pid: process.pid,
    });
  } catch { /* defter ASLA kapanışı geciktirmez */ }
});

// App-shell smoke probe: load the embedded app offscreen, assert the real app
// rendered (title + #__next root), log proof, then quit. Used to verify ADP-002
// without a display. Harmless when unset.
const APP_PROBE = process.env.CREWPANE_APP_PROBE === '1';

// ORPHAN-ELECTRON-01 — EBEVEYN-ÖLÜMÜ NÖBETÇİSİ. Kural + gerekçe + ölçüm TEK yerde:
// electron/e2eParentWatchdog.cjs (kontrol kolu de AYNI modülü koşturur — burada bir
// kopya yaşasaydı kanıt ürünü değil kopyayı ölçerdi). Yalnız CREWPANE_E2E=1 +
// ebeveyn pid'i verilmişse kurulur; teslim edilen üründe hiçbir zaman çalışmaz.
require('./src/core/e2eParentWatchdog.cjs').armE2EParentWatchdog({ quit: () => { noteQuit('watchdog', 'e2e-parent-gone'); app.quit(); } });
// Optional path + settle delay for the probe so it can load /workspace and wait
// for client-side terminals (xterm + pty) to mount before asserting. Harmless
// when APP_PROBE is unset.
const PROBE_PATH = process.env.CREWPANE_PROBE_PATH || '';
// ADP-111 — the app boots DIRECTLY into /workspace (the unified single-window view);
// the old dashboard at `/` now redirects here. The probe override (CREWPANE_PROBE_PATH)
// still wins so smoke tests can target any route — it already defaults to /workspace.
const START_PATH = '/workspace';
const PROBE_WAIT = Number(process.env.CREWPANE_PROBE_WAIT || 200);
// Probe can click the "+ New terminal" button N times to exercise multi-pane.
const PROBE_CLICKS = Number(process.env.CREWPANE_PROBE_CLICKS || 0);

// Mode resolution: explicit env wins; AUTOTEST implies spike; otherwise dev when
// unpackaged, prod when packaged.
function resolveMode() {
  if (AUTOTEST) return 'spike';
  const env = process.env.CREWPANE_MODE;
  if (env === 'dev' || env === 'prod' || env === 'spike') return env;
  return app.isPackaged ? 'prod' : 'dev';
}
const MODE = resolveMode();

// Log file path: in dev/spike (unpackaged) keep it next to the source for easy
// inspection; when packaged, __dirname is inside the read-only app.asar, so use
// the app's writable logs dir instead. Resolved lazily — app paths aren't
// available until `whenReady`. All writes are guarded so a read-only target can
// never crash the main process.
// ── Logger & Hata Altyapısı (Faz 3.2): src/shared/logger ─────────────────────
const logger = require('./src/shared/logger/index.js');
let LOG_PATH = null;
let LOG_TARGET = null;

function initLog() {
  const res = logger.initLog({
    app,
    mode: MODE,
    e2e: AUTOTEST || process.env.CREWPANE_E2E === '1',
  });
  LOG_PATH = res.logPath;
  LOG_TARGET = res.logTarget;
  return res;
}

const logLine = logger.logLine;

// ADP-946 — AYAR YAZIMININ DÜŞÜŞÜ ARTIK DOSYA LOG'UNA DÜŞER. `agentSettings` bunu
// yalnız `process.stderr`e yazabiliyordu; paketli Windows app Explorer'dan açılır,
// konsolu YOKTUR → satır hiçbir yere gitmiyordu. "Çalışma alanım kaydolmadı"
// şikâyeti tam da bu yüzden kanıtsız kalıyordu (destek log isteyip boş dönüyordu).
agentSettings.setPersistLogger((line) => logLine(`[settings] ${line}`));

// ADP-303 (A) — install the guards NOW (before any pty/window exists): a broken stdout pipe
// or a stray EPIPE must never reach Electron's crash dialog. A genuine bug still does
// (onFatal shows the dialog itself — suppressing it entirely would MASK real crashes: our
// listener makes Electron's default handler stand down, `listenerCount('uncaughtException') > 1`).
const stdioGuards = stdioGuard.installStdioGuards({
  proc: process,
  log: (msg) => {
    try { if (LOG_PATH) fs.appendFileSync(LOG_PATH, `[stdio] ${msg}\n`); } catch { /* best-effort */ }
  },
  // ADP-335 — GERÇEK KOD HATASI ARTIK ÇÖKME DİYALOĞU AÇMIYOR. Eren'in vakası: bir ajanın
  // yazdığı modülde (paneScreen) sıradan bir ReferenceError → uncaughtException → diyalog →
  // ÇALIŞAN OFİS ÖLDÜ. Artık: hata dürüstçe raporlanır (bildirim merkezi + log), ilgili
  // özellik degrade olur, UYGULAMA YAŞAR. Gizleme değil — bildirim tıklanınca dosya:satır
  // ve log açılır. Pencere YOKSA (açılıştan önce) diyalog kalır: orada sessizlik = kullanıcı
  // hiçbir şey göremeden ölmüş bir uygulama demek.
  onFatal: (err) => {
    reportModuleFault({
      module: 'main',
      label: 'uncaughtException',
      message: String((err && err.message) || err),
      location: moduleGuard.faultLocation(err),
      count: 1,
      stopped: false,
      fatal: true,
      at: Date.now(),
    }, { stack: err && err.stack }); // OBS-02 — yığın izi YALNIZ Sentry'ye (yolları maskeli)
    if (!appWindow || appWindow.isDestroyed()) {
      try {
        dialog.showErrorBox('A JavaScript error occurred in the main process', String((err && err.stack) || err));
      } catch { /* pre-ready / headless — the file log still has the stack */ }
    }
  },
});
logger.setStdoutGuard(() => stdioGuards.canWriteStdout());

// ── ADP-335 — MODÜL HATA SINIRI (bkz. moduleGuard.cjs) ──────────────────────────────────
// main'deki HERHANGİ bir modülde sıradan bir kod hatası (ReferenceError/TypeError) tüm
// uygulamayı çökertiyordu. Artık her riskli yüzey (VT harvest, gateway, SSE,
// sprint/queue yazımı, timer'lar) bir supervisor'ın içinde koşar: patlarsa O MODÜL degrade
// olur, diğerleri ve uygulama yaşar. Hata YUTULMAZ: log + tıklanabilir bildirim.
const moduleFaults = []; // son N hata (bildirim merkezi + `module:faults` IPC'si okur)
const supervisors = new Map();
// TEST-ONLY sentetik hata enjeksiyonu — hata sınırının GERÇEK uygulamada tuttuğunu kanıtlamak
// için (e2e). `CREWPANE_FAULT_INJECT=vt,gateway`. Env yoksa hiçbir etkisi yok.
const FAULT_INJECT = String(process.env.CREWPANE_FAULT_INJECT || '').split(',').map((s) => s.trim()).filter(Boolean);

// ─── OBS-02 — HATA TAKİBİ (Sentry) KÖPRÜSÜ ───────────────────────────────────
// Bu haftaki arızaların HEPSİ sessizdi: kullanıcı gördü, biz görmedik. Köprü şu:
// bildirim merkezinde beliren HER modül hatası aynı anda Sentry'ye de düşer.
// İKİNCİ BİR HATA YOLU AÇILMAZ — yeni `uncaughtException` dinleyicisi yok, yeni
// IPC kanalı yok; yalnız bu fonksiyonun sonuna bir MUSLUK eklendi. Böylece
// "Sentry'de var ama uygulamada yok" (ya da tersi) diye bir hata sınıfı doğamaz.
//
// Raporlayıcı BURADA (whenReady'den ÖNCE) kurulur: açılışın ilk saniyesinde patlayan
// bir modül de yakalansın. DSN yoksa nesne yine kurulur ama `capture` ilk satırda
// döner — yani ağ katmanına hiç inilmez.
let obsReporter = null;
function obsReporterNow() {
  if (obsReporter) return obsReporter;
  try {
    // INT-OBS-01 — anahtar artık ÖNCE Entegrasyon Merkezi'nin kurduğu yerden okunur;
    // `~/.crewpane/telemetry.env` GERİYE DÖNÜK olarak çalışmaya devam eder.
    const env = telemetryEnvNow();
    const channel = telemetryChannelMod.resolveChannel();
    obsReporter = errorReporter.createErrorReporter({
      dsn: telemetryChannelMod.resolveDsn(channel, env),
      channel,
      app: 'crewpane',
      appVersion: app.getVersion(),
      appRoot: path.resolve(__dirname, '..'),
      homeDir: os.homedir(),
      osInfo: { platform: process.platform, arch: process.arch, release: os.release() },
      // CANLI okuma: Ayarlar → Gizlilik'ten kapatıldığı an sonraki olay gitmez.
      enabled: () => telemetryEnabledNow(),
      log: (line) => logLine(line),
    });
  } catch (e) {
    // Raporlayıcı kurulamazsa uygulama YAŞAR — hata takibi hiçbir zaman arıza kaynağı olamaz.
    obsReporter = { capture: () => ({ sent: false, reason: 'init-failed' }), stats: () => ({}), enabledNow: () => false };
    try { logLine(`obs: raporlayıcı kurulamadı (${e && e.message})`); } catch { /* best-effort */ }
  }
  return obsReporter;
}

// ─── OBS-01 — ÜRÜN ANALİTİĞİ KÖPRÜSÜ ─────────────────────────────────────────
// İlk ödeyen müşteriler geldi ve neyi kullandıklarını bilmiyoruz: kaç kişi ilk
// ajanını çalıştırabildi, hangi panel açılıyor, hangi plan limitine çarpılıyor.
// Kablo `obsReporterNow` ile BİREBİR aynı desende kurulur (tembel · anahtar yoksa
// nesne yine var ama ilk satırda döner · kurulamazsa uygulama YAŞAR).
let analyticsClient = null;
function analyticsNow() {
  if (analyticsClient) return analyticsClient;
  try {
    const env = telemetryEnvNow(); // INT-OBS-01 — tek çözüm zinciri (bkz. obsReporterNow)
    const channel = telemetryChannelMod.resolveChannel();
    analyticsClient = analyticsMod.createAnalytics({
      apiKey: telemetryChannelMod.resolvePostHogKey(channel, env),
      host: telemetryChannelMod.resolvePostHogHost(env),
      // KİMLİK: heartbeat'in ZATEN ürettiği anonim kurulum uuid'si. İkinci bir
      // kimlik kavramı icat EDİLMEDİ — hesap/e-posta/cihaz adı analitiğe girmez.
      distinctId: () => {
        try { return telemetryStateForSend().installId; } catch { return null; }
      },
      // CANLI okuma: Ayarlar → Gizlilik'ten kapatıldığı an sonraki olay gitmez —
      // Sentry ile TEK VE AYNI anahtar (görev gereksinimi 4).
      enabled: () => telemetryEnabledNow(),
      base: () => analyticsBaseProps(),
      // Tampon boşaltma aralığı ayarlanabilir (destek + kanıt kapıları). Sınırlı:
      // 1 sn ile 5 dk arası — yanlış bir değer ne olay fırtınası ne de sonsuz
      // bekleme üretebilir.
      flushIntervalMs: (() => {
        const raw = Number(env.CREWPANE_POSTHOG_FLUSH_MS);
        return Number.isFinite(raw) ? Math.min(Math.max(raw, 1_000), 300_000) : undefined;
      })(),
      log: (line) => logLine(line),
    });
  } catch (e) {
    analyticsClient = {
      track: () => ({ sent: false, reason: 'init-failed' }),
      flush: () => ({ sent: false, reason: 'init-failed' }),
      stats: () => ({}), pending: () => 0, enabledNow: () => false,
    };
    try { logLine(`analytics: kurulamadı (${e && e.message})`); } catch { /* best-effort */ }
  }
  return analyticsClient;
}

/**
 * ORTAK DAMGA — her olayda. OBS-02'nin `baseTags`'iyle aynı bilgi + plan katmanı.
 * `tier` burada olmasa "hangi limite çarpan kaç kişi yükseltti" sorusu ikinci bir
 * "yükseltme olayı" icat etmeyi gerektirirdi; katman her olayın üstünde taşınınca
 * o geçiş panoda kendiliğinden bir zaman çizgisi olur.
 */
function analyticsBaseProps() {
  let tier = 'none';
  try {
    const s = seatGate ? seatGate.state() : null;
    if (s && s.tier) tier = s.tier;
  } catch { /* lisans okunamadı → 'none' */ }
  let locale = 'other';
  try { locale = (agentSettings.readSettings().locale || '').slice(0, 2) || 'other'; } catch { /* varsayılan */ }
  return {
    app: 'crewpane',
    channel: telemetryChannelMod.resolveChannel(),
    app_version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    os_release: os.release(),
    tier,
    locale,
  };
}

/**
 * AKTİVASYON KİLOMETRE TAŞI: bu kurulumda İLK KEZ mi oluyor?
 *
 * Huni PostHog'da kişi-bazlı da kurulabilir (aynı `distinct_id`in ilk olayı),
 * ama `first_time` bayrağı onu TEK SAYIMA indirir: "kaç kurulum ilk ajanını
 * çalıştırdı" sorusu huni yapılandırması olmadan, tek bir sayı olarak okunur.
 * İşaret ayarlara yazılır (yeniden açılışta tekrar 'ilk' saymasın).
 * @returns {boolean}
 */
function analyticsFirstTime(marker) {
  try {
    const cur = agentSettings.sanitizeTelemetryState(agentSettings.readSettings().telemetryState);
    if (cur.milestones.includes(marker)) return false;
    agentSettings.writeSettings({
      telemetryState: { ...cur, milestones: [...cur.milestones, marker] },
    });
    return true;
  } catch {
    return false; // yazamıyorsak 'ilk' DEME — huniyi şişirmek, boş bırakmaktan kötü.
  }
}

/** Modül adından Sentry YÜZEYİ (main | renderer | worker) — etiket tek kaynaktan. */
function obsSurfaceFor(moduleName) {
  if (moduleName === 'renderer') return 'renderer';
  if (moduleName === 'worker' || moduleName === 'pane') return 'worker';
  return 'main';
}

/**
 * @param {object} fault  bildirim merkezine + log'a giden kayıt (şekli DEĞİŞMEDİ)
 * @param {object} [extra] YALNIZ Sentry'ye giden ek bağlam (`{ stack }`). Bilerek
 *   `fault` içine konmaz: `moduleFaults` dizisi IPC ile renderer'a dönüyor ve
 *   bildirim kartının sözleşmesini genişletmenin bir sebebi yok.
 */
function reportModuleFault(fault, extra) {
  moduleFaults.push(fault);
  if (moduleFaults.length > 50) moduleFaults.shift();
  logLine(
    `MODULE FAULT ${fault.module}${fault.label ? `/${fault.label}` : ''}: ${fault.message} ` +
      `@ ${fault.location || '?'}${fault.stopped ? ' — MODÜL DURDURULDU (degrade)' : ''}`,
  );
  try {
    if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('module:fault', fault);
  } catch { /* pencere gitti — log'da zaten var */ }
  // OBS-02 — musluk. `capture` ASLA throw etmez (kendi içinde sarılı) ama burada da
  // koruyoruz: bir gün imza değişirse bile bildirim merkezi çalışmaya devam etsin.
  try {
    obsReporterNow().capture({
      surface: obsSurfaceFor(fault.module),
      module: fault.module,
      label: fault.label,
      message: fault.message,
      location: fault.location,
      stopped: fault.stopped,
      fatal: fault.fatal,
      level: fault.level,
      stack: extra && extra.stack,
      // SEN-F1 — ofis tuvali kurtarma zincirinin aşama bağlamı (varsa) Sentry
      // ETİKETİ olur; bir dahaki teşhis "hangi basamakta düştü" sorusunu
      // mesaj metnini okumadan yanıtlar.
      stage: fault.stage,
      renderer: fault.renderer,
      attempt: fault.attempt,
      // WIN-FIRSTRUN-01 (K5) — pane-exit etiketleri (motor · spawn'dan süre · ilk bayt).
      engine: fault.engine,
      msSinceSpawn: fault.msSinceSpawn,
      firstDataBytes: fault.firstDataBytes,
    });
  } catch { /* hata takibi hata üretmez */ }
}

/** Modül adına göre (tekil) supervisor. */
function supervisorFor(name) {
  let sup = supervisors.get(name);
  if (!sup) {
    sup = moduleGuard.createSupervisor({
      name,
      // OBS-02 — ham hata ikinci argümandan gelir; yığın izi YALNIZ Sentry'ye taşınır.
      onFault: (fault, err) => reportModuleFault(fault, { stack: err && err.stack }),
      log: (m) => logLine(`[guard] ${m}`),
    });
    supervisors.set(name, sup);
  }
  return sup;
}

// ---------------------------------------------------------------------------
// Terminal (node-pty) — ADP-003 generalises the ADP-001 single-pty bridge to
// N independent ptys so the workspace UI can render multiple terminals in one
// window. Each pty is keyed by an opaque `paneId` (minted in main on spawn);
// every IPC message carries that paneId so the renderer can route data/exit to
// the right xterm instance. Security model (contextIsolation/sandbox/preload
// whitelist) is unchanged from ADP-001.
// ---------------------------------------------------------------------------

// ADP-013 (ADR-002): the entry is now an agent-aware binding, not just a child.
// The runtime binding (paneId↔agentId↔child) lives HERE — process-authoritative
// and ephemeral by design (children die on app quit; the durable "which agent
// belongs in which slot" lives in employees.pane + localStorage, owned by the
// renderer). One entry per live terminal across all windows:
//   { child, win, agentId, department, command, label, cwd, pid, startedAt,
//     lastDataAt }
const ptys = new Map();
let paneSeq = 0;

// ─────────────────────────────────────────────────────────────────────────────
// ADP-705 — PANE⇄OTURUM ÇAPASI (bayat `--session-id` düzeltmesi)
//
// `entry.sessionId` spawn'da BİZİM verdiğimiz uuid'dir ve TÜM transcript probları
// (ADP-280 teslim doğrulaması, ADP-306 son-mesaj, okuma modu, mobil defter) ondan
// dosya yolu türetir. Pane REUSE edilirken paneRecycler `/clear` yazar → claude YENİ
// oturum açar → id BAYAT olur. Bayat dosyada prompt bulunmaz ve ADP-280 "teslim
// edilemedi" YALANI üretilirdi. Çapa sıfırlamayı görür, yeni oturumu proje dizininden
// bulur ve defteri tazeler; bulamazsa `null` döner → prob "bakılamadı" der, YALAN ASLA.
// ─────────────────────────────────────────────────────────────────────────────
const sessionAnchor = paneSessionAnchor.createSessionAnchor({
  listSessionHeads: (cwd, sinceMs) => transcriptProbe.listSessionHeads(cwd, undefined, { sinceMs }),
  log: (line) => logLine(line),
});

/**
 * Pane'in GÜNCEL claude oturum id'si. Sıfırlama sonrası çözülene kadar `null`
 * (çağıran bunu "bakılamadı" okur — ADP-280 sözleşmesi: yanlış hüküm ASLA).
 * Çözülür çözülmez pty defteri ve kalıcı kayıt tazelenir (restart-resume de düzelir).
 */
function currentSessionId(paneId) {
  const entry = ptys.get(paneId);
  if (!entry) return null;
  if (!sessionAnchor.isPending(paneId)) return entry.sessionId ?? null;
  // Sahiplenilmiş id'ler: başka bir pane'in defterini çalmayalım.
  const claimedIds = new Set();
  for (const [id, e] of ptys) {
    if (id !== paneId && e && e.sessionId) claimedIds.add(e.sessionId);
  }
  const found = sessionAnchor.resolve(paneId, {
    cwd: entry.cwd,
    claimedIds,
    // Sıfırlama TUTMAMIŞ olabilir (`/clear` slash-menüsüne düştü): eski defter
    // sıfırlamadan sonra hâlâ yazılıyorsa o id DOĞRUDUR — çapa bunu ayırt eder.
    knownSessionId: entry.sessionId ?? null,
  });
  if (!found) return null;
  entry.sessionId = found;
  try {
    livePaneRegistry.setSessionId(paneId, found, crewpaneHome());
  } catch {
    /* kalıcı kayıt best-effort — bellek defteri zaten doğru */
  }
  return found;
}

/**
 * ENG-02 — TESLİM PROBU, MOTOR FARKINDA. Tek boğaz: teslim/uyandırma doğrulamasının
 * DÖRT çağıranı da (supervisor'ın `transcriptHas` + `wakeVerifiable` +
 * `leaderTranscriptHas`, ve renderer'ın `pty:transcriptContains` IPC'si) buradan geçer.
 *
 * Daha önce dördü de claude-only'ydi ve codex pane'inde `null` dönüyordu → ADP-280/705/920
 * kurtarma merdiveni codex'te TAMAMEN devre dışıydı (ENG-R1 §6 Boşluk-2: "prompt yutulursa
 * kimse fark etmez"). Artık:
 *   claude → oturum defteri (`~/.claude/projects/…/<sessionId>.jsonl`)
 *   codex  → rollout defteri (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
 *   diğer  → dürüst "bakılamadı" (checked:false) — TAHMİN YOK.
 *
 * Dönüş `transcriptProbe.transcriptContains` sözleşmesidir (`{found, checked, file, reason}`),
 * böylece `deliveryVerdict.ts` tek hüküm kaynağı olarak kalır.
 *
 * @param {string} paneId
 * @param {string} needle
 * @param {{ sessionId?: string|null }} [o] claude dalında okunacak oturum id'si
 *   (verilmezse ADP-705 güncel-oturum çözümü koşar).
 */
function probeTranscriptContains(paneId, needle, o) {
  const entry = ptys.get(paneId);
  // ADP-896 — pane defterde yok: oturum hakkında hüküm veremeyiz ('no-pane').
  if (!entry) return { found: false, checked: false, file: null, reason: 'no-pane' };
  const clean = typeof needle === 'string' ? needle.slice(0, 200) : '';
  const engine = entry.command ?? 'claude';
  if (engine === 'claude') {
    const sessionId = o && 'sessionId' in o ? o.sessionId : currentSessionId(paneId);
    return transcriptProbe.transcriptContains({ cwd: entry.cwd, sessionId }, clean);
  }
  if (engine === 'codex') {
    // codex pane başına oturum kimliği VERMEZ → eşleme cwd + açılış zamanı ile yapılır
    // ve güven düşükse modül `checked:false` döner (yanlış "teslim edildi" YOK).
    return codexRolloutProbe.rolloutContains({ cwd: entry.cwd, startedAt: entry.startedAt }, clean);
  }
  return { found: false, checked: false, file: null, reason: 'engine-unsupported' };
}

/** `probeTranscriptContains`in üç-değerli hâli: true/false/null (null = bakılamadı). */
function probeTranscriptVerdict(paneId, needle, o) {
  const res = probeTranscriptContains(paneId, needle, o);
  return res && res.checked ? res.found : null;
}

/**
 * Bu pane'in defterine BAKILABİLİR mi? (supervisor'ın `wakeVerifiable` dalı.)
 * Yalnız hedef bilgisi sorulur; hüküm probun kendisinden gelir — eşleme belirsizse
 * çağıran zaten `null` görür ve ADP-667 davranışına (teslim=ack) düşer.
 */
function probeTranscriptVerifiable(paneId) {
  const e = ptys.get(paneId);
  if (!e) return false;
  const engine = e.command ?? 'claude';
  if (engine === 'claude') return !!(e.sessionId && e.cwd);
  if (engine === 'codex') return codexRolloutProbe.rolloutVerifiable({ cwd: e.cwd, startedAt: e.startedAt });
  return false;
}

/* ───────────────────────────────────────────────────────────────────────────
   TOK-C (D-02 v2) — HARCAMA FRENİNİN TEK UYGULAMA NOKTASI
   ───────────────────────────────────────────────────────────────────────────
   TOK-C'nin ilk turunda fren yalnız `pty:writeGuarded`e takılıydı ve o kapı
   "sistemin bir pane'e iş yazdığı TEK yol" sanılıyordu. ÖLÇÜLDÜ — değil:

     • görev dağıtımı:  taskAssignment.ts → sendCommand.ts → api.write
                        → preload `pty:input` → child.write        (fren YOKTU)
     • otomatik devam:  resumePtyDaemon.writeLine → writePane
                        → child.write                              (fren YOKTU)

   Yani ürünün para harcatan İKİ ana yolu frenin dışındaydı; kart "duraklatıldı"
   yazarken sistem o pane'e iş yazmaya devam edebiliyordu. Aşağıdaki iki yardımcı
   kararın TEK kaynağıdır: üç çağrı yeri de aynı ölçümü, aynı kuralı ve aynı
   görünürlüğü kullanır (sessiz düşürme yok — her red log'a düşer ve renderer'a
   `pty:budget-event` olarak gider; ofis balonu onunla ANINDA çıkar).            */

/** Bir pane'in bütçe kararı — kartın gördüğü ÖLÇÜMÜN AYNISINDAN türer. */
function paneBudgetDecisionFor(paneId, entry) {
  const e = entry || ptys.get(paneId);
  if (!e) return null;
  try {
    return paneBudgetStore.decide(
      paneId,
      tokenUsage.usageForPane({
        paneId,
        engine: e.command ?? null,
        cwd: e.cwd ?? null,
        sessionId: currentSessionId(paneId),
        startedAt: e.startedAt ?? null,
      }),
    );
  } catch (err) {
    // 🔴 Ölçüm patlarsa fren DEVREYE GİRMEZ (kural 2: ölçemediğimiz şey için
    // duraklatma yok). Sessiz de kalmaz — log'da izi olur.
    logLine(`pane bütçe kararı alınamadı paneId=${paneId}: ${err.message}`);
    return null;
  }
}

/**
 * Kapıyı uygula + duraklatmayı GÖRÜNÜR yap.
 * @returns {{allow: boolean, decision: object|null, reason: string}}
 */
function enforcePaneBudget({ paneId, entry, origin, source }) {
  const verdict = spendGuard.allowWrite({ origin, decision: null });
  // İnsan yazımı: ölçüm bile YAPILMAZ (kapı ona hiç uğramaz — hem doğru hem ucuz).
  if (verdict.allow && verdict.reason === 'human-input') return { allow: true, decision: null, reason: verdict.reason };
  const decision = paneBudgetDecisionFor(paneId, entry);
  const res = spendGuard.allowWrite({ origin, decision });
  if (res.allow) return { allow: true, decision, reason: res.reason };
  logLine(
    `${source} BÜTÇE DURAKLATTI paneId=${paneId} ölçüt=${decision.metric} ` +
      `kullanılan=${decision.used} limit=${decision.effectiveLimit} devam=${decision.resumeCount}`,
  );
  const e = entry || ptys.get(paneId);
  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.webContents.send('pty:budget-event', {
      kind: 'blocked',
      source,
      paneId,
      // Ofis balonu ajan sprite'ına bağlanır; bu alan KİMLİK DEĞİL ADRES'tir
      // (karar zaten verilmiştir, burada yalnız "hangi masaya yazılacak").
      agentId: (e && e.agentId) || null,
      budget: decision,
    });
  }
  return { allow: false, decision, reason: res.reason };
}

/* ───────────────────────────────────────────────────────────────────────────
   TOK-B (D-03) — DAĞITIM POLİTİKASI: "aynı pane'de sürdür" mü "taze oturum" mu
   ───────────────────────────────────────────────────────────────────────────
   TOK-OPT-01'in kuralı bugüne kadar liderin KAFASINDAYDI ve elle uygulanıyordu:
   bayat/dev bir oturuma yeni iş yazmak, TOK-OPT-01 ölçümünde olay başına medyan
   $3,45 (437 olay = $1.894) tutuyordu. Burası o kuralı ÜRÜNE koyar:

     ölçüm  → `tokenUsage` (kartın gördüğü defterin AYNISI: son isteğin bağlamı,
              boşta geçen dakika, tekilleştirilmiş istek sayısı)
     eşik   → `modelPricing.contextEconomics.dispatch` (koda gömülü sayı YOK)
     karar  → `dispatchPolicy.decide` (saf, kimlik körü)
     uygula → renderer'ın dağıtım yolları (delegasyon + board görevi) plan alır;
              'refresh' gelirse `pty:dispatchRefresh` tek istekle DEVİR ÖZETİ
              alır, `/clear` yazar, özeti yeni prompt'un başına verir.

   🔴 D-02'nin dersi burada da geçerli: karar SESSİZ olamaz. Her plan ve her
   tazeleme log'a düşer, kartta görünür ve `pty:dispatch-event` ile renderer'a
   gider — "ajanın hafızası sebepsiz silinmiş" hâli bu ürünün en pahalı yalanı
   olurdu.                                                                    */

/** Dağıtım hafızası: pane'e SON dağıtılan iş + kalıp korpusu (kimlik yok, adres var). */
const dispatchStore = dispatchPolicy.createStore({
  corpusWindow:
    (((tokenCost.DEFAULT_PRICING.contextEconomics || {}).dispatch || {}).relatedness || {}).corpusWindow || 50,
});

/** Pane'in tazeleme künyesi (kartın "uygulandı" satırı): paneId → {atMs, code, handoff…}. */
const dispatchApplied = new Map();

/** ESC → `/clear` dizisinin zamanlaması — paneRecycler.ts sabitlerinin AYNISI. */
const REFRESH_ESC_GAP_MS = 150;
const REFRESH_SUBMIT_GAP_MS = 400;
const REFRESH_GRACE_MS = 3000;
/**
 * Devir özeti için beklenecek en uzun süre; dolarsa özet YOK (uydurulmaz).
 * LDR-F1 — E2E DİKİŞİ: `CREWPANE_HANDOFF_TIMEOUT_MS` bu süreyi KISALTABİLİR.
 * Sebep: G3'ün kırmızı dalı ("motor sessiz → `/clear` YAZILMAZ") ancak zaman
 * aşımı GERÇEKTEN dolunca ölçülebilir; 90 sn'yi beklemek o kanıtı pratikte
 * alınamaz kılardı. Değer YALNIZ AŞAĞI çekilebilir (üretimde kimse timeout'u
 * uzatıp devir turunu pahalılaştıramasın) ve geçersiz/eksik env varsayılanı
 * AYNEN bırakır — ADP-428'in `CREWPANE_RESUME_RETRY_DELAYS_MS` deseni.
 */
const HANDOFF_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CREWPANE_HANDOFF_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1_000 && raw < 90_000 ? raw : 90_000;
})();
const HANDOFF_POLL_MS = 1_500;
/** Devir özetinin prompt'a taşınacak en büyük boyu (bağlam şişmesin diye). */
const HANDOFF_MAX_CHARS = 4_000;

/**
 * Bir pane için SÜRDÜR/TAZELE kararı — kartın gördüğü ÖLÇÜMÜN aynısından türer.
 * @param {string} paneId
 * @param {object|null} entry pty defteri satırı
 * @param {{text?: string|null}} opts dağıtılmak ÜZERE olan iş metni (varsa)
 */
function paneDispatchDecisionFor(paneId, entry, opts = {}) {
  const e = entry || ptys.get(paneId);
  if (!e) return null;
  try {
    const engine = e.command === 'claude' || e.command === 'codex' ? e.command : null;
    const usage = tokenUsage.usageForPane({
      paneId,
      engine: e.command ?? null,
      cwd: e.cwd ?? null,
      sessionId: currentSessionId(paneId),
      startedAt: e.startedAt ?? null,
    });
    const th = dispatchPolicy.thresholdsFrom(tokenCost.DEFAULT_PRICING, engine);
    const last = usage.lastRequest || null;
    const idleMinutes =
      last && typeof last.atMs === 'number' ? Math.floor(Math.max(0, Date.now() - last.atMs) / 60_000) : null;
    const rel = dispatchPolicy.relatedness({
      prevText: dispatchStore.lastText(paneId),
      nextText: typeof opts.text === 'string' ? opts.text : null,
      corpus: dispatchStore.corpus(),
      cfg: th && th.relatedness,
    });
    const decision = dispatchPolicy.decide({
      // 🔴 `sessionFound` (BU oturumun defteri) — toplamın ölçülmesi bu soruyu
      // cevaplamaz: politika SON isteğe bakar, tüm zamanların toplamına değil.
      measured: usage.sessionFound === true,
      ctxTokens: last ? last.ctxTokens : null,
      idleMinutes,
      requests: typeof usage.sessionRequests === 'number' ? usage.sessionRequests : null,
      related: rel.related,
      thresholds: th,
    });
    return { ...decision, relatedness: rel, engine, applied: dispatchApplied.get(paneId) || null };
  } catch (err) {
    // Ölçüm patlarsa POLİTİKA DEVREYE GİRMEZ (bugünkü davranış sürer) — ama sessiz kalmaz.
    logLine(`dağıtım kararı alınamadı paneId=${paneId}: ${err.message}`);
    return null;
  }
}

/** Kararın TEK log biçimi (DoD: "dispatch bu kuralı uyguluyor — log kanıtı"). */
function logDispatchDecision(paneId, decision, source) {
  const m = (decision && decision.measured) || {};
  const why = (decision.reasons || []).map((r) => `${r.code}(${r.value}≥${r.threshold})`).join(',') || '-';
  logLine(
    `dispatch-policy ${String(decision.action).toUpperCase()} paneId=${paneId} kaynak=${source} ` +
      `sebep=${decision.code} bağlam=${m.ctxTokens ?? '?'} boşta=${m.idleMinutes ?? '?'}dk ` +
      `istek=${m.requests ?? '?'} ilişki=${m.related === null || m.related === undefined ? 'ölçülemedi' : m.related} ` +
      `devir=${decision.handoff ? 'evet' : 'hayır'} gerekçe=${why}`,
  );
}

function sendDispatchEvent(payload) {
  if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('pty:dispatch-event', payload);
}

const dispatchSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ENT-F1 — ana sürecin teslim primitifi (pty defterine bağlı, tek örnek).
 * Yük vekili canlı pane sayısıdır: submit boşluğu yükle büyür (ADP-920).
 */
const deliverToPane = createDeliverPrompt({
  readPaneBuffer: (paneId) => {
    const e = ptys.get(paneId);
    return e ? e.buffer || '' : '';
  },
  writePane: (paneId, data) => {
    const e = ptys.get(paneId);
    if (!e) return false;
    try { e.child.write(data); return true; } catch { return false; }
  },
  sleep: dispatchSleep,
  now: () => Date.now(),
  livePaneCount: () => ptys.size,
  log: (line) => logLine(line),
});

/**
 * Pane'e prompt yaz VE TESLİMİ DOĞRULA (metin → yük-farkında boşluk → ENTER →
 * composer ölçümü → gerekirse artan gecikmeyle Enter tekrarı).
 *
 * ENT-F1 (P2) — eskiden `write(text)` → sabit 400 ms → `write('\r')` idi ve sonrası
 * ölçülmüyordu: yük altında o 400 ms yetmediğinde Enter TUI'nin render döngüsünde
 * yutuluyor, prompt composer'da `[Pasted text]` olarak asılı kalıyordu (ADP-920'nin
 * renderer'da çözdüğü arızanın ana süreçteki ikizi). Artık aynı çekirdek koşar.
 *
 * @param {string} paneId  pty defteri adresi (ENT-F1: primitif tamponu buradan okur —
 *   `ptys` girdisinin kendisinde paneId ALANI YOKTUR, adres anahtardır)
 * @returns {Promise<boolean>} teslim ÖLÇÜLEREK doğrulandı mı ('unknown' → false)
 */
async function writePromptToPane(paneId, text) {
  const res = await deliverToPane(paneId, text, {
    submitGapMs: REFRESH_SUBMIT_GAP_MS,
    label: 'devir-özeti',
  });
  return res.delivered;
}

/**
 * AXP-03 — AGENT X TESLİM YOLU. Renderer'ın `sendCommandToAgent`i "gönderim denendi"de
 * biterdi; bu yol ENT-F1 primitifini (`deliverToPane`) ve supervisor'ın hüküm merdivenini
 * (`deliveryVerdict` + `probeTranscriptVerdict`) kullanır, üstüne makbuz üretir ve
 * `agentx:receipt` ile ana pencere + Agent X pop-out'una yayınlar. Pane AÇMAZ (renderer'ın
 * işi): hedefin canlı pane'i yoksa ya da meşgulse makbuz `kuyrukta` olur ve pane boşa
 * düşünce kuyruk kendi dener.
 */
/**
 * AXP-12 — PANE'İN EKRAN METNİ (ham akış DEĞİL). claude 2.1.27x alternatif ekranda
 * mutlak imleçle çizer ve `\n` basmaz: ham `e.buffer`, `composerScan` için TEK SATIRA
 * çöker ("⏸ manual mode on · ? for shortcuts") → boşta pane "menu", Enter sonrası
 * "unknown" okunuyordu (#DV48/#YHL8/#6QG5; eski logda 35/162 ENT-F1 teslimi). Her pane
 * zaten gerçek bir VT (paneScreen = xterm-headless, ADP-324) taşıyor; composer'ı
 * OKUNUR hâle getiren tek girdi onun görünür satırlarıdır. Ekran yoksa/bozuksa
 * (degrade) ham tampona düşülür — davranış eskisi gibi, asla daha kötü değil.
 * Kapsam: YALNIZ Agent X teslim yolu (kart kuralı: süpervizör davranışı değişmez).
 */
function paneScreenText(entry) {
  if (!entry) return '';
  if (entry.screen && typeof entry.screen.liveLines === 'function') {
    try {
      const lines = entry.screen.liveLines();
      if (Array.isArray(lines) && lines.length) return lines.join('\n');
    } catch { /* degrade → ham tampon */ }
  }
  return entry.buffer || '';
}

/**
 * AXP-12 — Agent X'in ENT-F1 teslim primitifi: `deliverToPane` ile AYNI yazıcı/uyku/
 * yük vekili, tek fark okuyucu = VT ekran metni (yukarıdaki gerekçe). Süpervizör /
 * devir özeti / `/clear` yolları `deliverToPane`de kalır (bu dalgada dokunulmadı;
 * geçiş kararı AXP-12 raporu "Sonraki adım").
 */
const deliverToPaneAgentx = createDeliverPrompt({
  readPaneBuffer: (paneId) => paneScreenText(ptys.get(paneId)),
  writePane: (paneId, data) => {
    const e = ptys.get(paneId);
    if (!e) return false;
    try { e.child.write(data); return true; } catch { return false; }
  },
  sleep: dispatchSleep,
  now: () => Date.now(),
  livePaneCount: () => ptys.size,
  log: (line) => logLine(line),
});

const agentxDeliverer = agentxDeliverMod.createAgentxDeliver({
  listPanes: () => {
    const out = [];
    for (const [paneId, e] of ptys) {
      // AXP-12 — `buffer` = EKRAN metni (paneStateOf → composerScan bunu okur).
      out.push({ paneId, agentId: e.agentId || null, department: e.department || null, bytes: e.bytes || 0, buffer: paneScreenText(e) });
    }
    return out;
  },
  readPaneBuffer: (paneId) => paneScreenText(ptys.get(paneId)),
  deliver: (paneId, text, opts) => deliverToPaneAgentx(paneId, text, opts),
  transcriptHas: (paneId, needle) => probeTranscriptVerdict(paneId, needle),
  // AX-06 — yetki kapısı EYLEM SINIRINDA: konuşan bir AJANSA (lider) `teamScope.authorize`
  // (delegasyonla AYNI karar); konuşan kullanıcıysa (widget/pop-out) sahibidir → roster'ında
  // olan her ajana verebilir (roster kapsamı `resolveTarget`in kendisinde: rosterde
  // olmayan hedef zaten çözülmez).
  authorize: ({ actor, target }) => {
    const a = actor && typeof actor === 'object' ? actor : {};
    if (a.kind === 'agent') {
      return authorizeTeamScope({ action: 'delegate', leaderId: a.agentId || '', targetScope: target.teamId || '' });
    }
    return { ok: true, via: 'owner' };
  },
  emit: (receipt) => {
    try {
      if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('agentx:receipt', receipt);
    } catch { /* ana pencere kapalı olabilir */ }
    try {
      const w = jarvisWidgetAlive();
      if (w) w.webContents.send('agentx:receipt', receipt);
    } catch { /* pop-out kapalı olabilir */ }
  },
  sleep: dispatchSleep,
  now: () => Date.now(),
  log: (line) => logLine(line),
}, {
  // e2e/ölçüm dikişleri (ms) — üretimde DEFAULTS.
  ...(Number.isFinite(Number(process.env.CREWPANE_AGENTX_VERIFY_MS)) && process.env.CREWPANE_AGENTX_VERIFY_MS ? { verifyMs: Number(process.env.CREWPANE_AGENTX_VERIFY_MS) } : {}),
  ...(Number.isFinite(Number(process.env.CREWPANE_AGENTX_QUEUE_TICK_MS)) && process.env.CREWPANE_AGENTX_QUEUE_TICK_MS ? { queueTickMs: Number(process.env.CREWPANE_AGENTX_QUEUE_TICK_MS) } : {}),
});

/**
 * TEK İSTEKLE DEVİR ÖZETİ — "özetle-ve-tazele" akışının ölçülen yarısı.
 * Özet TUI ekranından KAZINMAZ: motorun KENDİ defterinden (transcript) okunur —
 * ANSI/çizim gürültüsü yok, "ekranda ne göründü" tahmini yok.
 * @returns {{ok:boolean, text:string|null, reason:string}}
 */
async function requestHandoffSummary(paneId, entry, decision) {
  const read = () =>
    transcriptProbe.lastAssistantMessage({ cwd: entry.cwd, sessionId: currentSessionId(paneId) });
  const before = read();
  const baseline = before.checked ? before.text : null;
  const ctxText = decision && decision.measured ? `${decision.measured.ctxTokens} jeton` : 'ölçülen bağlam';
  const prompt =
    `[OTOMATİK DEVİR — bu oturum tazelenecek (${ctxText}); sıradaki iş TAZE bir oturumda başlayacak] ` +
    'TEK mesajda devir özeti yaz: (1) nerede kaldın, (2) dokunduğun dosyalar (yol), ' +
    '(3) açık/riskli nokta, (4) sıradaki adım. En fazla 15 satır. Araç çağırma, başka iş yapma.';
  try {
    await writePromptToPane(paneId, prompt);
  } catch (err) {
    return { ok: false, text: null, reason: `write-failed:${err.message}` };
  }
  const deadline = Date.now() + HANDOFF_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await dispatchSleep(HANDOFF_POLL_MS);
    if (!ptys.has(paneId)) return { ok: false, text: null, reason: 'pane-gone' };
    const now = read();
    if (now.checked && typeof now.text === 'string' && now.text.trim() && now.text !== baseline) {
      // Gizli dizi maskesi: özet prompt'a taşınacak, maskeden GEÇMEDEN taşınmaz.
      const clean = secretRedactor.redactDeep({ text: now.text.trim() }).text;
      return { ok: true, text: clean.slice(0, HANDOFF_MAX_CHARS), reason: 'ok' };
    }
  }
  // 🔴 Zaman aşımı: özet UYDURULMAZ. Tazeleme yine yapılır (kural tetiklendi),
  // ama çağıran "devir yok" bilgisini alır ve log'a düşer.
  return { ok: false, text: null, reason: 'timeout' };
}

/**
 * Pane'in OTURUMUNU tazele: (isteğe bağlı) devir özeti + ESC + `/clear` + ENTER.
 * Süreç, kimlik (argv `--append-system-prompt`), MCP bağlantıları YAŞAR; yalnız
 * KONUŞMA sıfırlanır — paneRecycler'ın (ADP-266) tam olarak aynı mekanizması.
 */
async function refreshPaneSession(paneId, { handoff, decision, source, requireHandoff }) {
  const entry = ptys.get(paneId);
  if (!entry) return { ok: false, reason: 'no-pane', handoff: null };
  /* Tazeleme PARA HARCAR (özet isteği + taze oturumun ısınması) → bütçe freninden
     GEÇER. D-02'nin dersi: fren, harcayan her yola takılmalı. */
  const guard = enforcePaneBudget({ paneId, entry, origin: spendGuard.SYSTEM_ORIGIN, source: 'dispatch-refresh' });
  if (!guard.allow) return { ok: false, reason: 'budget-paused', handoff: null, budget: guard.decision };
  const resetCmd = entry.command === 'claude' ? '/clear' : entry.command === 'codex' ? '/new' : null;
  if (!resetCmd) return { ok: false, reason: 'engine-not-resettable', handoff: null };

  let handoffResult = { ok: false, text: null, reason: 'not-requested' };
  if (handoff) handoffResult = await requestHandoffSummary(paneId, entry, decision);
  if (!ptys.has(paneId)) return { ok: false, reason: 'pane-gone', handoff: handoffResult };

  /* ── LDR-F1 (G3) — DEVİR ÖZETİ ZORUNLU DALI ───────────────────────────────
     LDR-R1 B3: bugüne dek özet zaman aşımına uğrasa bile `/clear` YİNE atılıyordu
     (canlı log: 19 tazelemenin 2'si `devir=hayır(timeout)`). Worker'da bu tolere
     edilebilir — alt-görev metni zaten yeniden yazılacaktır. LİDERDE ise aynı
     davranış, TÜM oturum bağlamının KANITSIZ yok edilmesidir ve `/clear` geri
     alınamaz. Bu yüzden bayrak: özet gelmediyse pane'e sıfırlama YAZILMAZ, bağlam
     DURUR ve çağıran backoff'la yeniden dener.

     🔴 SINIR: bayrak yalnız özet İSTENDİĞİNDE (`handoff===true`) bağlar. Karar
     `handoff:false` derse taşınacak bağlam zaten taban altındadır (kayıp yok) —
     orada özet şartı koşmak tazelemeyi sonsuza dek kilitlerdi.
     🔴 GERİYE UYUM: bayrak VERİLMEZSE (worker yolu) bugünkü davranış AYNEN koşar. */
  const resetGate = leaderRefreshPolicy.resetGate({
    requireHandoff,
    handoffRequested: handoff === true,
    handoffOk: handoffResult.ok === true,
  });
  if (resetGate.block) {
    logLine(
      `dispatch-policy TAZELEME İPTAL paneId=${paneId} kaynak=${source} sebep=handoff-missing(${handoffResult.reason}) ` +
        '— sıfırlama YAZILMADI, bağlam DURUYOR (LDR-F1 G3)',
    );
    sendDispatchEvent({
      kind: 'refresh-blocked',
      paneId,
      agentId: entry.agentId || null,
      decision: decision || null,
      reason: 'handoff-missing',
      handoffReason: handoffResult.reason,
    });
    return { ok: false, reason: 'handoff-missing', handoff: handoffResult };
  }

  // ENT-F1 (P3) — SIFIRLAMA DA DOĞRULANIR. ENT-R1 §3 canlı log kanıtı: 22 sıfırlamanın
  // 4'ü `session-anchor: … sıfırlaması TUTMAMIŞ` ile bitmişti — doğrulanmayan bir
  // submit'in ikinci imzası. ESC (yarım girdiyi at) + komut YAZIMI burada kalır;
  // boşluk + `\r` + composer ölçümü primitife devredilir ('submit-only': metni AZ ÖNCE
  // biz yazdık, primitif İKİNCİ KEZ yazmaz).
  let resetDelivered = false;
  try {
    entry.child.write('\x1b'); // yarım kalmış girdi satırını at (ADP-270 dersi)
    await dispatchSleep(REFRESH_ESC_GAP_MS);
    entry.child.write(resetCmd);
  } catch (err) {
    return { ok: false, reason: `reset-write-failed:${err.message}`, handoff: handoffResult };
  }
  try {
    const res = await deliverToPane(paneId, resetCmd, {
      mode: 'submit-only',
      submitGapMs: REFRESH_SUBMIT_GAP_MS,
      label: `sıfırlama(${resetCmd})`,
    });
    resetDelivered = res.delivered;
    if (!resetDelivered) {
      logLine(
        `dispatch-policy SIFIRLAMA DOĞRULANAMADI paneId=${paneId} komut=${resetCmd} ` +
          `hüküm=${res.outcome} enter=${res.enters} — ` +
          `oturum SIFIRLANMAMIŞ olabilir (session-anchor bunu ayrıca ölçer)`,
      );
    }
  } catch (err) {
    return { ok: false, reason: `reset-write-failed:${err.message}`, handoff: handoffResult };
  }
  // ADP-705 — sıfırlamadan sonra oturum id'si BİLİNMEZ; çapa işaretlenmezse
  // ölçüm bayat defteri okumaya devam eder (kart da politika da yanılırdı).
  sessionAnchor.markReset(paneId);
  dispatchStore.clear(paneId); // yeni konuşmanın "önceki işi" yoktur
  await dispatchSleep(REFRESH_GRACE_MS); // motor temizlerken yazılan prompt yutulur

  const applied = {
    atMs: Date.now(),
    code: decision ? decision.code : null,
    reasons: decision ? decision.reasons : [],
    handoff: handoffResult.ok,
    handoffReason: handoffResult.reason,
    // ENT-F1 — sıfırlamanın ÖLÇÜLEN hükmü. `false` "kesin tutmadı" demek değildir
    // ('unknown' da false'tur) — ama "tuttu" iddiası artık ancak ölçümle yazılır.
    resetDelivered,
    source: source || null,
  };
  dispatchApplied.set(paneId, applied);
  logLine(
    `dispatch-policy TAZELENDİ paneId=${paneId} kaynak=${source} sebep=${applied.code} ` +
      `devir=${handoffResult.ok ? `evet(${(handoffResult.text || '').length} karakter)` : `hayır(${handoffResult.reason})`}`,
  );
  sendDispatchEvent({
    kind: 'refreshed',
    paneId,
    agentId: entry.agentId || null,
    decision: decision || null,
    applied,
  });
  return { ok: true, reason: 'ok', handoff: handoffResult, applied };
}

/* ───────────────────────────────────────────────────────────────────────────
   LDR-F1 — LİDER OTURUMUNUN OTOMATİK TAZELENMESİ (tetik yüzeyi)
   ───────────────────────────────────────────────────────────────────────────
   LDR-R1'in tek cümlesi: "otomatik tazeleme ÜRÜNDE VAR, doğru çalışıyor ve lider
   için TAZELE diyor — ama o kararı KİMSE SORMUYOR." `dispatchPolicy` bir GELEN-İŞ
   kapısıdır (yalnız delegasyon + board görevi yolunda koşar); liderin bağlamını
   büyüten üç yol (kullanıcının kendi promptları · tur-başı brifing · supervisor
   uyandırması) o kapıdan HİÇ geçmez. Ölçülen canlı kanıt: 42 `dispatch-policy`
   satırının 42'si `kaynak=delegation`, lider kaynaklı SIFIR karar.

   BURASI YENİ BİR KARAR ÜRETMEZ. `paneDispatchDecisionFor` neyi ölçüyorsa o,
   `dispatchPolicy.decide` ne diyorsa o. Eklenen tek şey kararın SORULMASI ve
   liderde daha sıkı bir güvenlik kapısı.

   🔴 YENİ ÖLÇÜM TURU AÇILMADI (D-02 dersi: iki yüzey iki ana bakmasın). Tetik,
   rozetin ZATEN koşan 90 sn'lik `pty:tokenUsage` turuna binerr; ayrı bir
   setInterval yok, ayrı bir ölçüm yolu yok.

   AKIŞ (LDR-R1 §5.2):
     karar='refresh' + pane LİDER + kip='auto'
       → (G2) güvenli an: injectionGate(ardışık iki tampon) + uçuşta delegasyon YOK
       → (G3) devir özeti ZORUNLU: gelmezse `/clear` YAZILMAZ (requireHandoff)
       → (G4) mevcut `refreshPaneSession` (ESC + /clear + çapa) — yeniden yazılmadı
       → (G5) taze oturumun İLK mesajı: devir özeti + AÇIK alt-görevler + görev kodu
   ─────────────────────────────────────────────────────────────────────────── */

/** paneId → {attempts, lastAttemptAtMs, lastRefreshAtMs, running, reason, retryAtMs}. */
const leaderRefreshState = new Map();

/** İki tampon örneklemesi arasındaki GERÇEK gecikme (supervisor'ın deseni). */
const LEADER_GATE_SAMPLE_MS = 400;

function leaderRefreshEntry(paneId) {
  let st = leaderRefreshState.get(paneId);
  if (!st) {
    st = {
      attempts: 0,
      lastAttemptAtMs: 0,
      lastRefreshAtMs: 0,
      running: false,
      reason: null,
      // 🔴 `reason` HER TURDA üzerine yazılır (erteleme gerekçesi de oraya düşer);
      // BAŞARISIZLIK sebebi ayrı yaşamalı, yoksa "neden tazelenemedi" cevabı bir
      // sonraki turun 'backoff'u ile SİLİNİR ve kullanıcı gerçek sebebi hiç görmez.
      lastFailure: null,
      retryAtMs: null,
    };
    leaderRefreshState.set(paneId, st);
  }
  return st;
}

/**
 * Bu pane LİDERİN KENDİ pane'i mi?
 * İKİ şart birden: (a) ham rol slug'ı bir lider rolü (TEK KAYNAK leaderRole.cjs),
 * (b) pane bir DELEGASYON EXECUTION pane'i DEĞİL (`disallowSubagent`). (b) olmadan
 * bir liderin worker olarak açılmış pane'i de "lider" sayılırdı — supervisor'ın
 * `findLeaderPane`i tam olarak aynı ikinci şartı uygular.
 * 🔴 Karar KİMLİĞE (ad) değil ROLE + DURUMA bakar.
 */
function isLeaderPane(entry) {
  if (!entry) return false;
  return leaderRole.isLeaderRoleSlug(entry.role) && entry.disallowSubagent !== true;
}

/** Ayar: 'off' | 'warn' | 'auto' (varsayılan 'warn' — ürün lidere kendiliğinden yazmaz). */
function leaderAutoRefreshMode() {
  try {
    return leaderRefreshPolicy.normalizeMode(agentSettings.readSettings().leaderAutoRefresh);
  } catch {
    return leaderRefreshPolicy.DEFAULT_MODE;
  }
}

/** Zamanlama parametreleri CONFIG'ten (koda gömülü sayı yok). */
function leaderAutoRefreshConfig() {
  try {
    return leaderRefreshPolicy.leaderConfigFrom(tokenCost.DEFAULT_PRICING);
  } catch {
    return leaderRefreshPolicy.leaderConfigFrom(null);
  }
}

/** Bu liderin UÇUŞTAKİ (settle olmamış) delegasyon sayısı — defter main'de kalıcıdır. */
function leaderInFlightCount(agentId) {
  if (!agentId || !delegationSupervisor) return 0;
  try {
    const st = delegationSupervisor.leaderStatus(String(agentId));
    const recs = (st && st.records) || [];
    return recs.filter((r) => r.status !== 'done' && r.status !== 'failed' && r.status !== 'undelivered').length;
  } catch {
    // Defter okunamadıysa "uçuşta iş YOK" diyemeyiz → güvenli taraf: 1 say, ERTELE.
    return 1;
  }
}

/** Bu liderin AÇIK alt-görevleri (G5 geri yüklemesinin ikinci yarısı). */
function leaderOpenSubtasks(agentId) {
  if (!agentId || !delegationSupervisor) return [];
  try {
    const st = delegationSupervisor.leaderStatus(String(agentId));
    return ((st && st.records) || []).filter(
      (r) => r.status !== 'done' && r.status !== 'failed' && r.status !== 'undelivered',
    );
  } catch {
    return [];
  }
}

/**
 * G2 — GÜVENLİ AN. İki ARDIŞIK tampon örneklemesi arasında GERÇEK gecikme olmalı
 * (`leaderComposerIdle` iki okumayı karşılaştırır: tek okuma "stabil" hükmü veremez).
 * supervisor `wakeLeaders`in aynı deseni — yeni bir kapı İCAT EDİLMEDİ.
 */
async function sampleLeaderGate(paneId) {
  const before = ptys.get(paneId);
  if (!before) return { safe: false, reason: 'no-pane' };
  const prev = before.buffer || '';
  await dispatchSleep(LEADER_GATE_SAMPLE_MS);
  const after = ptys.get(paneId);
  if (!after) return { safe: false, reason: 'no-pane' };
  return leaderComposer.injectionGate(prev, after.buffer || '', {
    lastInputAt: typeof after.lastInputAt === 'number' ? after.lastInputAt : null,
    lastSubmitAt: typeof after.lastSubmitAt === 'number' ? after.lastSubmitAt : null,
    now: Date.now(),
  });
}

/**
 * ROZETİN VERİSİ — renderer bu hükmü ÜRETMEZ, yalnız basar (budget/dispatch ile
 * aynı disiplin: eşik aritmetiği iki yerde yaşarsa kartın yazdığı ile kapının
 * uyguladığı sessizce ayrışır).
 */
function leaderRefreshViewFor(paneId, entry, decision) {
  const leader = isLeaderPane(entry);
  const mode = leaderAutoRefreshMode();
  const cfg = leaderAutoRefreshConfig();
  const badge = leaderRefreshPolicy.badgeState({ decision, mode, cfg });
  const st = leaderRefreshState.get(paneId) || null;
  return {
    isLeader: leader,
    mode,
    state: badge.state,
    pct: badge.pct,
    ctxTokens: badge.ctxTokens,
    threshold: badge.threshold,
    code: badge.code,
    warnPct: Math.round(cfg.warnRatio * 100),
    // Son turun makine-okur gerekçesi (ipucunda "neden henüz tazelemedi" cevabı).
    lastReason: st ? st.reason : null,
    // Son BAŞARISIZ denemenin sebebi. `lastReason`dan AYRI olmak ZORUNDA: o her
    // turda değişir ve bir sonraki turun 'backoff'u gerçek sebebi ('handoff-missing')
    // sessizce silerdi — kullanıcı "neden tazelenemedi"yi bir daha hiç göremezdi.
    lastFailure: st ? st.lastFailure : null,
    attempts: st ? st.attempts : 0,
    retryAtMs: st ? st.retryAtMs : null,
    lastRefreshAtMs: st ? st.lastRefreshAtMs : 0,
    running: !!(st && st.running),
  };
}

/**
 * G5 — TAZE OTURUMUN İLK MESAJI. Yazım `injectionGate`ten TEKRAR geçer: `/clear`
 * sonrası motor hâlâ temizliyor olabilir ve kullanıcı o boşlukta yazmaya başlamış
 * olabilir (ADP-667'nin yarım-prompt clobber'ı burada da gerçektir).
 */
async function restoreLeaderContext(paneId, entry, handoffText) {
  const text = leaderRefreshPolicy.composeLeaderRestorePrompt({
    handoffText,
    openSubtasks: leaderOpenSubtasks(entry.agentId),
    taskCode: entry.taskId || labelTaskCodeOf(entry.label) || null,
  });
  if (!text) return { ok: false, reason: 'nothing-to-restore', chars: 0 };
  const gate = await sampleLeaderGate(paneId);
  if (!gate.safe) {
    logLine(`lider-tazeleme GERİ YÜKLEME ERTELENDİ paneId=${paneId} sebep=enjeksiyon-iptal(${gate.reason})`);
    return { ok: false, reason: `unsafe:${gate.reason}`, chars: text.length };
  }
  const delivered = await writePromptToPane(paneId, text);
  logLine(
    `lider-tazeleme GERİ YÜKLENDİ paneId=${paneId} karakter=${text.length} teslim=${delivered ? 'ölçüldü' : 'ölçülemedi'}`,
  );
  return { ok: true, reason: delivered ? 'delivered' : 'unverified', chars: text.length };
}

/**
 * TETİK — rozetin 90 sn'lik turundan çağrılır (fire-and-forget; ölçüm yolunu ASLA
 * bekletmez). `auto` DIŞINDAKİ her kipte tek bayt yazmadan döner.
 */
function leaderRefreshTick(paneId, entry, decision) {
  const st = leaderRefreshEntry(paneId);
  if (st.running) return;
  const mode = leaderAutoRefreshMode();
  const cfg = leaderAutoRefreshConfig();
  const leader = isLeaderPane(entry);
  // UCUZ ÖN-ELEME: `auto` değilse ya da lider değilse tampon bile örneklemeyiz
  // (90 sn'de bir HER pane için 400 ms uyumak, ölçmediğimiz bir şey için harcamadır).
  const pre = leaderRefreshPolicy.refreshGate({
    decision,
    mode,
    isLeader: leader,
    nowMs: Date.now(),
    attempts: st.attempts,
    lastAttemptAtMs: st.lastAttemptAtMs,
    lastRefreshAtMs: st.lastRefreshAtMs,
    inFlight: 0,
    gate: { safe: true, reason: 'not-sampled' },
    cfg,
  });
  /* 🔴 ÖN-ELEME "ok" DEDİYSE BU BİR HÜKÜM DEĞİLDİR — yalnız "örneklemeye devam".
     Eskiden burası `st.reason`u koşulsuz yazıyordu ve e2e bunu KIRMIZIYA düşürdü:
     tetik ölçüm turunun İÇİNDE koşar, rozetin verisi ise AYNI turda kurulur →
     kullanıcı gerçek gerekçe ('unsafe:draft') yerine bir sonraki 400 ms'de
     silinecek bir 'ok' görüyordu. Sonuç: "neden tazelemiyor?" sorusunun cevabı
     ekranda titriyordu. Gerekçe ancak SONUÇLANDIĞINDA yazılır. */
  if (!pre.go) {
    st.reason = pre.reason;
    st.retryAtMs = pre.retryAtMs;
    return;
  }

  st.running = true;
  void (async () => {
    try {
      const inFlight = leaderInFlightCount(entry.agentId);
      const gate = inFlight > 0 ? { safe: false, reason: 'delegation-in-flight' } : await sampleLeaderGate(paneId);
      const verdict = leaderRefreshPolicy.refreshGate({
        decision,
        mode,
        isLeader: leader,
        nowMs: Date.now(),
        attempts: st.attempts,
        lastAttemptAtMs: st.lastAttemptAtMs,
        lastRefreshAtMs: st.lastRefreshAtMs,
        inFlight,
        gate,
        cfg,
      });
      st.reason = verdict.reason;
      st.retryAtMs = verdict.retryAtMs;
      if (!verdict.go) {
        // 🔴 ERTELEME DENEME DEĞİLDİR (ADP-672): sayaç ARTMAZ, backoff büyümez.
        logLine(`lider-tazeleme ERTELENDİ paneId=${paneId} sebep=${verdict.reason} bağlam=${(decision.measured || {}).ctxTokens ?? '?'}`);
        return;
      }
      // Karar log'a TEK biçimde düşer — `kaynak=leader-auto` (LDR-R1 §2.4: bugüne
      // dek bu satırın 42/42'si `kaynak=delegation`'dı, lider kaynaklı SIFIR karar).
      logDispatchDecision(paneId, decision, 'leader-auto');
      const res = await refreshPaneSession(paneId, {
        handoff: decision.handoff,
        requireHandoff: true, // G3 — liderde devir özeti ZORUNLU
        decision,
        source: 'leader-auto',
      });
      if (!res.ok) {
        st.attempts += 1;
        st.lastAttemptAtMs = Date.now();
        st.reason = res.reason;
        st.lastFailure = res.reason;
        st.retryAtMs = leaderRefreshPolicy.nextRetryAtMs(st.attempts, st.lastAttemptAtMs, cfg);
        logLine(
          `lider-tazeleme BAŞARISIZ paneId=${paneId} sebep=${res.reason} deneme=${st.attempts}/${cfg.maxAttempts} ` +
            `sonraki=${new Date(st.retryAtMs).toISOString()}`,
        );
        return;
      }
      st.attempts = 0;
      st.lastAttemptAtMs = Date.now();
      st.lastRefreshAtMs = Date.now();
      st.retryAtMs = null;
      st.reason = 'refreshed';
      st.lastFailure = null;
      const live = ptys.get(paneId);
      if (live) await restoreLeaderContext(paneId, live, res.handoff && res.handoff.text);
    } catch (err) {
      st.reason = `error:${err.message}`;
      logLine(`lider-tazeleme patladı paneId=${paneId}: ${err.message}`);
    } finally {
      st.running = false;
    }
  })();
}

// PANE-CAP-01 — ADP-264'ün SABİT canlı-pane tavanı (MAX_LIVE_PANES = 24) KALDIRILDI.
//
// Gerekçe ölçüldü (02.09): 4 takım 24 pane'e ulaşınca `pty:spawn rejected:
// pane-limit: 24 canlı pane var` 10 kez basıldı ve sprint-1788372649141 0/10 düştü —
// hiçbir iş yapılmadı, oysa 38,7 GB'lık makinede kaynak vardı. Sabit sayı yanlış
// araçtı: 36 GB'ta 24 hafif pane baskı yaratmaz, 8 GB'ta 12 ağır pane makineyi
// swap'e boğar. ADP-264'ün korumak istediği şey (kaçak döngü makineyi boğmasın)
// artık ÖLÇÜMLE karşılanıyor: `resourceGovernor` bellek baskısını 5 sn'de bir okur.
//
// KRİTİK FARK: bekçi ENGELLEMEZ, SORAR. Eşik altında spawn düşmez — kullanıcı tek
// kart görür ("yine de aç / bitmiş pane'leri kapat / bekle") ve "yine de aç" HER
// ZAMAN vardır (Eren 02.09: "hiçbir limit olmaması gerekiyor"). Bekçi Ayarlar'dan
// tamamen kapatılabilir; ölçüm yapılamazsa fail-open.
const resourceGovernorModule = require('./src/terminal/resourceGovernor.cjs');
let _resourceGovernor = null;
let _resourceGovernorTimer = null;

/** Kaynak bekçisi tekili (TEMBEL — ayar okuması app hazır olmadan güvenilmez). */
function resourceGovernor() {
  if (_resourceGovernor) return _resourceGovernor;
  let settings;
  try {
    settings = agentSettings.readSettings().resourceGovernor;
  } catch {
    settings = undefined; // ayar okunamadı → modül varsayılanları (fail-open ruhu)
  }
  if (!settings) {
    settings = { enabled: false, warnFreePct: 1, criticalFreePct: 0 };
  }
  _resourceGovernor = resourceGovernorModule.createGovernor({
    settings,
    log: (line) => logLine(line),
    onChange: (state) => {
      if (appWindow && !appWindow.isDestroyed()) {
        try { appWindow.webContents.send('resource:pressure', state); } catch { /* pencere gitti */ }
      }
    },
  });
  return _resourceGovernor;
}

/** Örneklemeyi başlat (idempotent). Zamanlayıcı `unref` — çıkışı geciktirmez. */
function startResourceGovernorSampling() {
  if (_resourceGovernorTimer) return;
  const gov = resourceGovernor();
  const period = Math.max(1000, Number(gov.state().settings.sampleMs) || 5000);
  try { gov.sample(); } catch (err) { logLine(`resourceGovernor ilk ölçüm patladı: ${err.message}`); }
  _resourceGovernorTimer = setInterval(() => {
    try { gov.sample(); } catch (err) { logLine(`resourceGovernor ölçüm patladı: ${err.message}`); }
  }, period);
  if (_resourceGovernorTimer.unref) _resourceGovernorTimer.unref();
  logLine(`resourceGovernor: örnekleme başladı (${period} ms)`);
}

// ADP-050 — the live app window (IPC target for the delegation bridge) + the
// started bridge handle ({ port, token, stop, info }). One window in this app.
let appWindow = null;
let delegationBridge = null;
// ADP-593 — gömülü Next sunucusunun kökü (`http://127.0.0.1:<port>`); pop-out
// pencereleri bu kökten `/popout` yükler. createAppWindow'da doldurulur.
let appBaseUrl = null;
// ADP-095 — the internal-browser <webview> guest webContents (CDP target). Set on
// did-attach-webview, cleared on destroy. Reachable ONLY in main (never the guest
// or the renderer) so headed automation stays main-gated.
let appWindowGuest = null;
// ADP-870 — hafıza RAG indeksleme yöneticisi (tekil, TEMBEL). Tembel olması önemli:
// uygulama açılışında hiçbir maliyet doğurmaz; ilk `memoryIndex:*` çağrısında kurulur.
// İlerleme olayları renderer'a 'memoryIndex:event' ile push edilir (pencere yoksa yutulur).
let memoryIndexerSingleton = null;
function memoryIndexer() {
  if (!memoryIndexerSingleton) {
    memoryIndexerSingleton = memoryIndexService.createIndexService({
      repoRoot: REPO_ROOT,
      logLine,
      // WIN-W6A — yerel model yokken indeks de barındırılan motorla kurulsun
      // (yoksa indeks vektörsüz kalır ve arama sonsuza kadar kelime katmanında).
      hostedKeyEnv: hostedEmbedKeyEnv,
      onEvent: (payload) => {
        try {
          if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('memoryIndex:event', payload);
        } catch {
          /* pencere kapanıyor */
        }
      },
    });
  }
  return memoryIndexerSingleton;
}

// SEARCH-2 — GENEL ARAMA İNDEKSİ (tekil, TEMBEL; memoryIndexer ile AYNI desen).
// ⚠️ AYRI DB: ADP-900'ün hafıza indeksine rapor/oturum eklemek onun parmak izini
// bozar ve kullanıcıya 21 dakikalık yeniden gömme ödetir (ADP-900 §5). Bu indeks
// salt kelime (FTS5), vektör YOK — dolayısıyla model/indirme yolu da yok.
let searchIndexSingleton = null;
let searchIndexRootKey = '';
function searchIndexer() {
  const root = agentWorkspaceRoot || '';
  // Çalışma alanı değiştiyse servis de değişir (her kökün indeksi ayrı dosyada).
  if (searchIndexSingleton && searchIndexRootKey !== root) {
    try {
      searchIndexSingleton.dispose();
    } catch {
      /* kapanıyor */
    }
    searchIndexSingleton = null;
  }
  if (!searchIndexSingleton) {
    const key = crypto.createHash('sha1').update(String(root || 'no-workspace')).digest('hex').slice(0, 12);
    searchIndexRootKey = root;
    searchIndexSingleton = searchIndexService.createSearchIndexService({
      dbFile: path.join(instancePaths.instanceHome(os.homedir()), 'search-index', `${key}.db`),
      repoRoot: REPO_ROOT,
      workspaceRoot: root,
      // TEST DİKİŞİ: defterlerin kökü. e2e bunu geçici bir dizine pinler — aksi
      // hâlde test, KULLANICININ GERÇEK 4,5 GB oturum geçmişini indeksler: hem
      // yavaş hem de bir testin dokunmaması gereken veri.
      home: process.env.CREWPANE_SEARCH_HOME || os.homedir(),
      sessionsEnabled: agentSettings.readSettings().memorySearch.sessionsIndexed !== false,
      logLine,
      onEvent: (payload) => {
        try {
          if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('searchIndex:event', payload);
        } catch {
          /* pencere kapanıyor */
        }
      },
    });
  }
  return searchIndexSingleton;
}

/**
 * WIN-W6A — ÇATALLANAN GÖMME ÇOCUKLARINA SIR KÖPRÜSÜ.
 *
 * Gömme işi `fork` + `ELECTRON_RUN_AS_NODE` ile doğan çocukta koşar; orada
 * `require('electron')` YOKTUR, yani `safeStorage` KASASI OKUNAMAZ. Kasadaki API
 * anahtarını yalnız ANA süreç çözebilir — bu yüzden köprü BURADA, main'de durur
 * (servis modülleri kimlik kapısını require etmez; gerekçesi
 * memoryIndexService.cjs'teki seam notunda: paketleme kapanışı).
 *
 * Yerel gömme modeli kuruluysa hosted hiç devreye girmez ve bu fonksiyon `{}` döner.
 * Sır loglanmaz, IPC'de dolaşmaz — yalnız kendi çocuğumuzun `env`ine girer.
 */
function hostedEmbedKeyEnv() {
  try {
    return memoryEmbedHosted.hostedKeyEnv();
  } catch (err) {
    logLine(`memoryEmbed: barındırılan anahtar köprüsü kurulamadı (${err.message}) — çocuk kapıyı kendisi deneyecek`);
    return {};
  }
}

// ADP-871 — hafıza HİBRİT ARAMA servisi (tekil, TEMBEL). İndeksleyiciden AYRI:
// indeksleme dakikalar süren toplu iş, arama ise etkileşimli. Gömme çocuğu ilk
// aramada ısınır ve 5 dk boştalıkta kapanır (RAM geri döner).
let memorySearcherSingleton = null;
function memorySearcher() {
  if (!memorySearcherSingleton) {
    memorySearcherSingleton = memorySearchService.createSearchService({
      repoRoot: REPO_ROOT,
      logLine,
      // ADP-900 — kullanıcı anlam katmanını kapatabilir (model diskte kalsa bile).
      // Ayar HER ÇAĞRIDA okunur: kapatma anında etkili olsun, restart gerekmesin.
      semanticEnabled: () => agentSettings.readSettings().memorySearch?.semanticEnabled !== false,
      hostedKeyEnv: hostedEmbedKeyEnv,
    });
  }
  return memorySearcherSingleton;
}

// ADP-900 — ONAYLI GÖMME MOTORU KURULUMU (tekil, TEMBEL). İlerleme renderer'a
// 'memoryEmbed:event' ile gider. Kurulum yöneticisi ONAY DAMGASI olmadan tek bayt
// indirmez (memoryEmbedInstall.consentMatches) — kapı burada değil ORADA, çünkü
// renderer'a güvenilemez.
let memoryEmbedInstallerSingleton = null;
function memoryEmbedInstaller() {
  if (!memoryEmbedInstallerSingleton) {
    memoryEmbedInstallerSingleton = memoryEmbedInstall.createInstaller({
      repoRoot: REPO_ROOT,
      logLine,
      onEvent: (payload) => {
        try {
          if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('memoryEmbed:event', payload);
        } catch {
          /* pencere kapanıyor */
        }
      },
    });
  }
  return memoryEmbedInstallerSingleton;
}

// ADP-872 — spawn'daki hibrit RAG'ın ANLAM katmanı. Spawn senkrondur ve 543 MB'lık
// gömme modelini bekleyemez; bu yüzden spawn kelime katmanıyla koşar ve sorgu
// vektörünü ARKA PLANDA ısıtır (memorySearchService.warmQuery → disk önbelleği).
// Sonraki spawn iki katmanlı (RRF) olur. Hata yutulur: hafıza bir pane açılışını
// asla bloklayamaz.
agentRunner.setSpawnMemoryWarm(({ workspaceRoot, query }) => {
  try {
    memorySearcher()
      .warmQuery({ workspaceRoot, query })
      .catch((err) => logLine(`memorySearch: spawn ısıtma başarısız: ${err.message}`));
  } catch (err) {
    logLine(`memorySearch: spawn ısıtma başlatılamadı: ${err.message}`);
  }
});

/* ───────────────────────────────────────────────────────────────────────────
   D-07 (K4) — HAFIZA KULLANIM ÖLÇÜMÜ: enjekte edilen kayıt İŞE YARADI MI?
   ───────────────────────────────────────────────────────────────────────────
   D-04'ün raporu bu ölçümü ELLE yapmıştı (transkriptte kaydın adı/dosyası geçiyor
   mu). Burası onu ürüne koyar: pane'in oturumu bitince defterdeki AÇIK enjeksiyonlar
   transkripte karşı yoklanır.

   🔴 "ÖLÇEMEDİM" ≠ "KULLANILMADI": transkript çözülemiyorsa (cwd/sessionId yok,
   dosya okunamıyor) probe `null` döner ve kayıt AÇIK KALIR — ölçülmemiş bir şeyi
   "kullanılmadı" diye yazmak, sonraki seçkiyi haksız yere budardı.
   🔴 Kullanım = ATIF (slug'ın metinde geçmesi). Etki ölçülemez; bu yüzden
   davranışsal sınıf (memoryTargeting.BEHAVIORAL_TYPES) cezadan MUAFtır.        */
function settleMemoryUsage(opts = {}) {
  try {
    const ledger = agentRunner.memoryLedger();
    if (!ledger) return null;
    const res = ledger.settle(
      (entry) => {
        if (!entry || !entry.cwd || !entry.sessionId) return null; // ölçemedim
        const file = transcriptProbe.resolveTranscriptFile(entry.cwd, entry.sessionId);
        if (!file) return null;
        const tail = transcriptProbe.readTail(file);
        if (tail === null) return null;
        return (entry.slugs || []).filter((s) => tail.includes(s));
      },
      {
        filter: opts.paneId ? (e) => e.paneId === opts.paneId : undefined,
        // 7 günden eski ve HÂLÂ ölçülemeyen kayıt defteri şişirmesin (sayaca girmez).
        maxAgeMs: 7 * 24 * 60 * 60 * 1000,
      },
    );
    if (res && (res.settled || res.unmeasured)) {
      logLine(`memory ledger: ${res.settled} enjeksiyon kapandı, ${res.used} kullanım, ${res.unmeasured} ölçülemedi`);
    }
    return res;
  } catch (err) {
    logLine(`memory ledger settle failed: ${err.message}`);
    return null;
  }
}

// ADP-150 (multi-tab) — every live <webview> guest, keyed by its webContents id.
// appWindowGuest is the ACTIVE tab's guest; the renderer reports the active tab via
// 'browser:setActiveGuest'. We ONLY ever set appWindowGuest to an id present here —
// the app renderer can never be selected as a CDP target.
const browserGuests = new Map();

// ADP-333 — SEKME SAHİPLİĞİ. Eren'in vakası: ajan sekme-1'de koşuyor, Eren sekme-2'yi
// açıyor, ajanın SONRAKİ işlemi EREN'IN sekmesinde çalışıyor (gezinti bozuluyor, üstelik
// ajan yanlış sayfada tıklıyor → sessiz hatalı işlem). Kök neden: her ajan işlemi
// `appWindowGuest`e (= AKTİF SEKME) gidiyordu; aktif sekmeyi ise KULLANICI değiştiriyor.
//
// Kural: **ajan tarafında "aktif sekme" diye bir kavram YOKTUR.** Her ajan kendi sekmesine
// (guest webContents id) kilitlenir. Sekmesi yoksa/kapandıysa KENDİNE YENİ sekme açar —
// kullanıcının sekmesine asla girmez. "Aktif sekme" yalnız İNSAN yolunda kullanılır
// (Jarvis'in "geri git"i, patronun baktığı sayfayı kasteder).
const guestOwners = new Map(); // guest webContents id → agentId
const agentGuests = new Map(); // agentId → guest webContents (sahiplenilen sekme)
// Aynı ajandan arka arkaya gelen işlemler TEK sekme isteği doğurur (yoksa hazırlık
// döngüsü onlarca <webview> açar ve renderer'ı çökertir — ADP-333 koşusunda görüldü).
const agentTabPending = new Map(); // agentId → Promise<guest>

// ── ADP-396 — İNSAN YOLUNUN HEDEFİ SAHİPLİĞE BAĞLIDIR (kaçak kapatıldı) ──────────
//
// ADP-333 ajanı KULLANICININ sekmesinden korudu; ama ters yön korunmamıştı: her guest
// attach'ında `appWindowGuest = guest` KOŞULSUZ yapılıyordu. Ajan arka planda kendi
// sekmesini açar açmaz, agentId TAŞIMAYAN insan yolunun (Jarvis sesli komutları,
// renderer'ın browser:action'ı) hedefi de o GÖRÜNMEZ sekme oluyordu → Jarvis "tıkladım"
// diyor, Eren'in baktığı sayfada hiçbir şey olmuyor (ADP-392 K4).
//
// Kural: paylaşılan "aktif hedef" değişkeni ZAMANA (son attach kazanır) değil SAHİPLİĞE
// bağlanır. SAHİPLİ (ajan) bir guest, SAHİPSİZ (insan) yolun hedefi OLAMAZ — hiçbir yoldan.
const isOwnedGuest = (id) => guestOwners.has(id);

/** İnsan yoluna uygun son sekme (sahipsiz). Ajan sekmelerine ASLA düşmez. */
function lastUnownedGuest() {
  const unowned = [...browserGuests.values()].filter((g) => !g.isDestroyed() && !isOwnedGuest(g.id));
  return unowned.length ? unowned[unowned.length - 1] : null;
}

// Sahiplik attach'tan SONRA (renderer'ın dom-ready'sinde, browser:setTabOwner ile) bildirilir;
// yani attach ANINDA "bu kimin sekmesi?" bilinmez. Bu sayaç, main'in KENDİ istediği ajan
// sekmesini (resolveAgentGuest) o pencerede tanır → attach insan hedefini kirletmez. İkinci
// savunma katmanı setTabOwner'daki geri-alma (kaçak penceresi kapanır).
let pendingAgentTabs = 0;

// ADP-028 — per-pane rolling output buffer so a <Terminal> that ATTACHES to an
// already-running pane (instead of spawning a fresh one) can replay recent
// scrollback into its xterm. Bounded; `bytes` is the cumulative count emitted so
// far and travels with every `pty:data` as `seq` (lets an attaching renderer
// dedupe live events it already received via the replayed buffer).
const PANE_BUFFER_MAX = 256 * 1024;
// PERF-BG-01 — kırpma PAYI: tampon tavanı bu kadar aşınca kırpılır (bkz. onData).
// Pay ne kadar büyükse düzleştirme o kadar seyrek; bellek bedeli pane başına en
// fazla bu kadardır. 64 KB = tipik chunk'ın ~24 katı → düzleştirme ~24 chunk'ta bir.
const PANE_BUFFER_SLACK = 64 * 1024;
/** ADP-324 — ilerleme satırı (`pane-live`) yayın kısıtı: spinner saniyede onlarca kez değişir. */
const PANE_LIVE_THROTTLE_MS = 500;

// ADP-475 — crash instrumentation. Eren's incident: the app died TWICE during
// a heavy build, with NO log line at all. A reactive handler can't help there
// — a SIGKILL (macOS jetsam memory-pressure kill) never runs any of our JS.
// The only evidence that survives is something written to disk BEFORE the
// kill: a periodic heartbeat (fs.appendFileSync via logLine is synchronous),
// so even the LAST tick before a kill is durable. crashWatchdog.cjs is the
// pure decision core (unit-tested); this just samples real Electron/OS state
// on an interval and feeds it through.
const WATCHDOG_TICK_MS = Number(process.env.CREWPANE_WATCHDOG_TICK_MS || 5000);
let watchdogTimer = null;
let watchdogPrevTotalBytes = null;
let watchdogPrevPaneBytes = new Map();
let watchdogPrevTickAt = null;
// ADP-727 — OTOMATİK HEAP SNAPSHOT (varsayılan KAPALI, opt-in).
// Bu görevin en pahalı dersi: renderer 4,5 GB'a çıkmıştı ama CANLI app'ten heap
// snapshot ALINAMIYORDU (paketli app'te uzak hata-ayıklama portu yok) → "4,5 GB'ı
// NE tutuyor" sorusu ancak izole kopyada TEKRAR ÜRETİLEBİLDİĞİ kadar cevaplanabildi.
// Bir daha olmasın diye: `CREWPANE_HEAP_SNAPSHOT_MB=3000` ile başlatılırsa,
// renderer o eşiği geçtiğinde app KENDİ heap snapshot'ını log dizinine yazar.
// OTURUM BAŞINA BİR KEZ — snapshot renderer'ı saniyelerce durdurur, sürekli
// tetiklenirse tedavi hastalıktan kötü olur.
const HEAP_SNAPSHOT_MB = Number(process.env.CREWPANE_HEAP_SNAPSHOT_MB || 0);
let heapSnapshotTaken = false;
function maybeAutoHeapSnapshot(appMetrics) {
  if (!HEAP_SNAPSHOT_MB || heapSnapshotTaken) return;
  const rendererMb = (crashWatchdog.memoryByType(appMetrics).Renderer || 0) / 1024 ** 2;
  if (rendererMb < HEAP_SNAPSHOT_MB) return;
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  heapSnapshotTaken = true; // eşiği bir kez geç, bir kez yaz
  const file = path.join(app.getPath('logs'), `renderer-${Date.now()}.heapsnapshot`);
  logLine(`[watchdog] renderer ${rendererMb.toFixed(0)}MB ≥ ${HEAP_SNAPSHOT_MB}MB → heap snapshot yazılıyor: ${file}`);
  Promise.resolve(win.webContents.takeHeapSnapshot(file))
    .then(() => logLine(`[watchdog] heap snapshot yazıldı: ${file}`))
    .catch((e) => logLine(`[watchdog] heap snapshot BAŞARISIZ: ${e.message}`));
}
// ---------------------------------------------------------------------------
// CRASH-R1 (madde 5) — BELLEK UYARISI: TEK SATIR, ÖNERİ, OTOMATİK KAPATMA YOK.
// ---------------------------------------------------------------------------
// ÖLÇÜM ÖNCE: bu makinede watchdog eşiği (1536 MB birleşik working-set) SÜREKLİ
// aşılıyor — 16.09 gecesinin altı günlük dosyasında 49 'warn' satırı var ve
// hiçbiri bir olayın habercisi değildi. Yani eşiğin HER geçilişinde kullanıcıya
// bildirim atmak GÜRÜLTÜDÜR ve gerçek uyarıyı sağırlaştırır.
//
// Bu yüzden advisory: (a) OTURUMDA BİR KEZ, (b) yalnız uyarı ısrarlıysa
// (ADVISE_TICKS ardışık tick = ~1 dk), (c) ÖNERİ verir, karar kullanıcınındır.
// OTOMATİK PANE KAPATMA YOKTUR — ürün kullanıcının çalışan oturumunu kendi
// kararıyla kapatmaz (bu kartın açık şartı).
//
// Kullanıcıya çıkan ASIL 'dur ve sor' yüzeyi resourceGovernor'ın 'critical'
// kartıdır (kullanılabilir bellek < %15); burası onun ALTINDAKİ kademedir ve
// bilerek yalnız günlüğe yazar.
const ADVISE_TICKS = 12; // 12 × 5 sn ≈ 1 dk ısrarlı uyarı
let memAdviseStreak = 0;
let memAdvised = false;
function maybeAdviseMemory(assessment, panes) {
  if (memAdvised) return;
  if (!assessment || assessment.level !== 'warn') { memAdviseStreak = 0; return; }
  memAdviseStreak += 1;
  if (memAdviseStreak < ADVISE_TICKS) return;
  memAdvised = true;
  // Öneri SOMUT olsun: veri akmayan pane'ler adaydır (throughput ölçümü zaten var).
  const idle = (Array.isArray(panes) ? panes : []).filter((x) => x && x.bytesPerSec === 0).map((x) => x.paneId);
  const hint = idle.length
    ? `en eski boş pane'ler aday: ${idle.slice(0, 3).join(', ')}`
    : 'boş pane yok — açık pane sayısını azaltmak yardımcı olur';
  logLine(
    `⚠️ BELLEK UYARISI — ${(assessment.totalBytes / 1024 ** 2).toFixed(0)} MB birleşik bellek, `
    + `${ptys.size} pane açık. ÖNERİ: kullanmadığın bir pane'i kapat (${hint}). `
    + 'Otomatik kapatma YAPILMADI — karar senin.',
  );
}
function watchdogTick() {
  try {
    const memUsage = process.memoryUsage();
    const appMetrics = app.getAppMetrics();
    maybeAutoHeapSnapshot(appMetrics);
    const assessment = crashWatchdog.assessMemory({ memUsage, appMetrics }, watchdogPrevTotalBytes);
    const now = Date.now();
    const currPaneBytes = new Map();
    for (const [paneId, entry] of ptys) currPaneBytes.set(paneId, entry.bytes || 0);
    const dtMs = watchdogPrevTickAt ? now - watchdogPrevTickAt : 0;
    const panes = crashWatchdog.paneThroughput(watchdogPrevPaneBytes, currPaneBytes, dtMs);
    // Quiet ticks stay OUT of the log (a line every 5s forever would bury the
    // signal) — only log when something is worth a post-mortem correlating,
    // OR periodically anyway so a SIGKILL always has a recent heartbeat within
    // reach (every 6th tick ≈ 30s, independent of whether anything is "warn").
    const heartbeatDue = assessment.level === 'warn' || panes.some((p) => p.burst);
    watchdogTick._n = (watchdogTick._n || 0) + 1;
    if (heartbeatDue || watchdogTick._n % 6 === 0) {
      // ADP-727 — appMetrics + zaman damgası da geçilir: hangi SÜREÇ TÜRÜ şişiyor
      // ve saatte kaç MB, artık logdan doğrudan okunur (bkz. formatHeartbeat).
      logLine(crashWatchdog.formatHeartbeat({ memUsage, assessment, panes, appMetrics, at: new Date().toISOString() }));
    }
    maybeAdviseMemory(assessment, panes);
    watchdogPrevTotalBytes = assessment.totalBytes;
    watchdogPrevPaneBytes = currPaneBytes;
    watchdogPrevTickAt = now;
  } catch (e) {
    // Sampling itself must never crash the app it's trying to protect.
    logLine(`watchdog tick error: ${e.message}`);
  }
}
// VOICE-TRUNC-01 — ANA SÜREÇ DURMA İZİ. Ölçüldü: ana süreç dikte burst'ü sırasında
// ≥ ~600 ms yanıt vermezse macOS AgentVoice'un sentetik tuş olaylarını düşürüyor
// (698 karakterlik prompt'un 500'ü kayboldu; 700 ms blokajda 255 olayın 45'i ulaştı).
// Olay gecesi neyin durdurduğu günlükte YOKTU — bu monitör bir sonraki kayıpta
// "[main-stall] ~N ms" satırını bırakır (çekirdek mainStallMonitor.cjs, testli).
// PERF-FLEET-01 — DURMA ARTIK YALNIZ GÜNLÜĞE YAZILMIYOR. 08.09 panic'inden önce
// bu satırlar 1 sn → 18 → 23 → 30 sn'ye tırmandı ve KULLANICI HİÇBİR ŞEY GÖRMEDİ
// (crewpane-shell.4.log). `onStall` damgayı kaynak bekçisine taşır; bekçi zaten
// ekranda olan kartı (ResourceGovernorCard) kendi `onChange`'iyle açar — yeni bir
// bildirim sistemi KURULMADI, olan kapıya bağlandı.
// RG-STALL-01 — sapma artık MONOTONİK saatle ölçülür (modül varsayılanı `hrtime.bigint`)
// ve 60 sn'lik akla yatkınlık tavanı uygulanır: tavanın üstü `[main-clock-jump]` satırı
// olur, `onStall` ÇAĞRILMAZ — yani uyku/askı artık bekçiyi kritiğe düşürmez.
const mainStallMonitor = require('./src/core/mainStallMonitor.cjs').createStallMonitor({
  setInterval, clearInterval, now: Date.now, log: logLine,
  onStall: (ev) => {
    try { resourceGovernor().noteStall(ev); } catch { /* bekçi yoksa durma izi yine günlükte */ }
  },
});
// RG-STALL-01 — İKİNCİ KEMER: uyku/uyanış kancası. `powerMonitor` 0.2.45'e kadar hiç
// kullanılmıyordu; uyanıştaki tek dev tik "ana süreç durdu" sanılıp bekçiyi kritiğe
// düşürüyordu (RG-CAP-01 §3.2). Tavan bu tiki zaten sıçrama sayar, bu kanca ise sapmanın
// hiç ÜRETİLMEMESİNİ sağlar. `app.whenReady()` sonrası kurulur (powerMonitor şartı).
let powerMonitorBound = false;
function bindPowerMonitorToStallMonitor() {
  if (powerMonitorBound) return;
  try {
    const { powerMonitor } = require('electron');
    if (!powerMonitor || typeof powerMonitor.on !== 'function') return;
    powerMonitor.on('suspend', () => {
      try { mainStallMonitor.suspend(); logLine('[main-power] sistem askıya alındı — durma ölçümü duraklatıldı'); } catch { /* kanca asla açılışı düşürmez */ }
    });
    powerMonitor.on('resume', () => {
      try { mainStallMonitor.resume(); logLine('[main-power] sistem uyandı — ilk tik atlanacak (monitör sıfırlandı)'); } catch { /* aynı */ }
    });
    powerMonitorBound = true;
  } catch { /* headless/test: kanca yoksa tavan tek başına korur */ }
}
function startCrashWatchdog() {
  if (watchdogTimer) return;
  logLine(`crash watchdog started (tick=${WATCHDOG_TICK_MS}ms)`);
  watchdogTimer = setInterval(watchdogTick, WATCHDOG_TICK_MS);
  watchdogTimer.unref?.();
  bindPowerMonitorToStallMonitor();
  mainStallMonitor.start();
}
function stopCrashWatchdog() {
  if (!watchdogTimer) return;
  clearInterval(watchdogTimer);
  watchdogTimer = null;
  mainStallMonitor.stop();
}

/**
 * node-pty ships a `spawn-helper` binary in its prebuild. On macOS/Linux the pty
 * fork posix_spawn's it — but an npm extract (or asar pack) can drop the +x bit,
 * surfacing only as a cryptic "posix_spawnp failed". Make it self-healing across
 * both the dev tree and a packaged app.asar.unpacked location.
 */
function ensureSpawnHelperExecutable() {
  if (process.platform === 'win32') return;
  const rel = path.join('node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
  const candidates = [
    path.join(__dirname, 'node_modules', rel),
    // Packaged: node-pty is unpacked out of the asar (see electron-builder.json
    // asarUnpack). app.getAppPath() → …/Resources/app.asar.
    path.join(app.getAppPath() + '.unpacked', 'node_modules', rel),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'node_modules', rel),
  ];
  for (const helper of candidates) {
    try {
      const mode = fs.statSync(helper).mode;
      if (!(mode & 0o111)) {
        fs.chmodSync(helper, 0o755);
        logLine(`fixed spawn-helper exec bit: ${helper}`);
      }
    } catch {
      /* not present at this candidate path — try the next */
    }
  }
}

/**
 * ADP-386 — RESUME spawn'ının replay-buffer tohumu: önceki oturumun ekran kuyruğu
 * (varsa) + net durum satırları. Salt görüntü — attach bunu xterm'e replay eder,
 * böylece restore edilen pane engine'in ilk baytından önce de SİYAH değildir.
 */
function restoreSeedText(opts) {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const tail = Array.isArray(opts.screenTail)
    ? opts.screenTail.filter((s) => typeof s === 'string')
    : [];
  const out = [];
  if (tail.length) {
    out.push(dim(`── önceki oturum — son ${tail.length} satır ──`));
    out.push(...tail);
    out.push('');
  }
  out.push(dim('── oturum devam ettiriliyor (restore) — ajan çıktısı bekleniyor… ──'));
  return out.join('\r\n') + '\r\n';
}

/**
 * Spawn an agent-aware pty (ADP-013). Backward compatible with ADP-003: a bare
 * `{ cols, rows }` (no `command`) still launches the login shell, so the
 * ADP-001 spike regression and existing `<Terminal>` callers are unaffected.
 *
 * With `command: 'claude'|'codex'` (whitelisted) the agent CLI runs IN the pane,
 * labelled with `agentId`/`department`/`label` for the binding store. An
 * arbitrary `command` string THROWS (RCE guard, ADR-002) — the IPC handler lets
 * that reject so a compromised renderer cannot exec arbitrary binaries.
 */
/**
 * B-01 (F-7) — AKTİF izole ağaçların yolları (yerel defterden).
 * Kanıt çözümü ve Raporlar izleyicisi bunu tüketir. Defter okunamazsa BOŞ liste:
 * izolasyon devrede değilken bugünkü davranış bit-bit korunur.
 */
/**
 * REPORTS-ROOT-01 — Raporlar sekmesinin (okuyucu + izleyici) eşlenmiş repo kökleri:
 * settings.projectRepos + worktrees.json slug'ları, supervisor'ın `resolveProjectRepo`
 * kuralıyla çözülür (tek kaynak: resultRoot.cjs). Asla throw etmez.
 */
function mappedProjectRootsForReports() {
  try {
    return resultRootMod.mappedProjectRoots(agentWorkspaceRoot, {
      settings: agentSettings.readSettings(),
      store: worktreeStore,
      homedir: crewpaneHome(),
      log: logLine,
    });
  } catch (err) {
    logLine(`reports: eşlenmiş repo kökleri çözülemedi (${err && err.message ? err.message : err})`);
    return [];
  }
}

function activeWorktreePaths() {
  try {
    return worktreeStore.listByState('active', crewpaneHome()).map((r) => r.path).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * B-01 — İZOLASYON POLİTİKASI: bu proje worktree modunda mı?
 *
 * VARSAYILAN **KAPALI** (`'off'`). GIT-BACKBONE-SPEC §2.1 ilke 3'ün ("fail-closed
 * ama geri-uyumlu") uygulaması: bugünkü kurulumlarda hiçbir proje kaydı yok ve
 * izolasyon açık gelseydi HER spawn "proje repo'su tanımlı değil" ile DURURDU —
 * yani bir iyileştirme, çalışan bir uygulamayı kırardı. Kullanıcı bir projeyi
 * `settings.projectIsolation` ile açtığında (ya da B-02'nin proje ekranı yazdığında)
 * omurga devreye girer; o andan sonra o proje için sessiz paylaşımlı-ağaç YOKTUR.
 */
function projectIsolationMode(project) {
  try {
    const s = agentSettings.readSettings();
    const map = s && s.projectIsolation;
    const v = map && typeof map === 'object' ? map[String(project || '').toLowerCase()] : null;
    return v === 'worktree' ? 'worktree' : 'off';
  } catch {
    return 'off';
  }
}

/**
 * B-01 (§2.5) — pane'i doğurmadan ÖNCE görevin izole ağacını hazırla.
 *
 * @returns {Promise<{trusted?:object, blocked?:boolean, why?:string}|null>}
 *   `trusted` → spawnPty'ye geçirilecek kademe-0 bağı.
 *   `blocked:true` → spawn HİÇ yapılmaz (izolasyon açık ama hazırlanamadı).
 *   `null` → izolasyon devrede değil; bugünkü davranış birebir.
 */
async function prepareTaskIsolation(opts) {
  const isAgent = typeof opts?.command === 'string' && opts.command !== 'shell';
  if (!isAgent) return null;
  const taskId = typeof opts?.taskId === 'string' && opts.taskId.trim() ? opts.taskId.trim() : null;
  if (!taskId) return null; // görevsiz pane izole edilmez (ADP-003 sade terminal dahil)

  const project = (typeof opts?.project === 'string' && opts.project.trim())
    || (typeof opts?.department === 'string' && opts.department.trim())
    || '';
  const isolation = projectIsolationMode(project);
  if (isolation !== 'worktree') return null;

  // Kod: görev kimliğinden ya da etiketten — TEK kaynaktan (taskCode.cjs).
  const code = taskCodeMod.taskCodeOf(opts.label) || taskCodeMod.taskCodeOf(taskId) || taskId;
  const repo = projectRepos.resolveProjectRepo(project, agentWorkspaceRoot, {
    settings: agentSettings.readSettings(),
    store: worktreeStore,
    homedir: crewpaneHome(),
    log: logLine,
  });
  if (!repo) {
    return { blocked: true, why: `proje '${project}' için git deposu bulunamadı (H-5) — izolasyon açıkken paylaşımlı ağaçta koşulmaz` };
  }

  const res = await worktreeService.ensure({
    taskId,
    code,
    project,
    agentId: typeof opts?.agentId === 'string' ? opts.agentId : null,
    paneId: null,
    workspaceRoot: agentWorkspaceRoot,
    repoPath: repo.repoPath,
    defaultBranch: (worktreeStore.getProject(project, crewpaneHome()) || {}).defaultBranch || 'dev',
    isolation,
    // F-8/H-4b — "mevcut sahip canlı mı" sorusunu main KENDİ defterinden ölçer,
    // çağıranın iddiasından değil (ADP-953'ün dersi).
    ownerLive: (ownerAgentId) => {
      for (const e of ptys.values()) if (e && e.agentId === ownerAgentId) return true;
      return false;
    },
    homedir: crewpaneHome(),
    log: logLine,
  });
  if (!res.ok) {
    if (res.degrade) return null; // geri-uyum yolu: bugünkü davranış
    return { blocked: true, why: res.why };
  }
  for (const n of res.notes || []) logLine(`worktree[${taskId}]: ${n}`);
  return { trusted: { taskWorktree: res.path, taskBranch: res.branch, taskId } };
}

/**
 * B-01 — GÖREVİN İZOLE AĞACINI ÇÖZ (SENKRON, git çağrısı YOK).
 *
 * Yalnız DEFTERE ve `statSync`'e bakar: kayıtlı bir worktree varsa yolunu verir.
 * Ağacı YARATMAZ — yaratma (`worktreeService.ensure`, ölçülen 7.4 sn) asenkron
 * `pty:spawn` yolunda, spawnPty'den ÖNCE koşar. Bu ayrım bilinçlidir: `spawnPty`
 * restart-resume ve daemon respawn gibi SENKRON yollardan da çağrılıyor ve orada
 * main sürecini 7 saniye bloklamak uygulamayı dondururdu.
 *
 * `taskId` renderer'dan gelebilir — bu bir KİMLİKTİR, yol değil. Yolu main kendi
 * defterinden türetir; renderer bir dizin adı söyleyemez (G-1).
 */
/**
 * ENG-OPENCODE-PROVIDER-01 — asenkron ön-uçuş girdileri `spawnPty`nin plan'ıyla AYNI
 * kaynaklardan çözülür (komut → descriptor, ikili, cwd, env); sonuç `cwd`+`model`
 * damgalıdır ve spawnPty yalnız damga tutuyorsa kullanır (tutmuyorsa senkron yeniden ölçer).
 * Herhangi bir adımda hata → null (spawnPty kendi senkron yoluna düşer; log orada).
 */
async function preflightModelGate(opts, trusted) {
  try {
    const command = typeof opts.command === 'string' ? opts.command : '';
    if (!command || command === 'shell') return null;
    const descriptor = engineRegistry.getEngine(command);
    if (!descriptor || !descriptor.modelGate) return null;
    const model = agentRunner.sanitizeModel(opts.model, command);
    if (!model) return null;
    const resolved = agentRunner.resolveCommand(command);
    const env = agentRunner.sanitizeEnv(opts.env, process.env);
    const bin = engineInstall.resolveBinary(resolved.file, env);
    const settings = agentSettings.readSettings();
    const wt = (trusted && trusted.taskWorktree) || (resolveTaskWorktreeSync(opts) || {}).taskWorktree;
    const cwd = agentRunner.resolveCwd(opts, agentWorkspaceRoot, resolved.isAgent, settings.departmentDirs, null, resolved.isAgent ? wt : undefined);
    return await opencodeModelGate.preflight({
      descriptor,
      model,
      bin,
      env,
      cwd,
      settings,
      t: appI18n.t,
      locale: appI18n.getLocale(),
      label: (engineInstall.installInfo(command) || {}).label || command,
    });
  } catch (e) {
    logLine(`model gate ön-uçuş atlandı (senkron yol ölçecek): ${e && e.message}`);
    return null;
  }
}

function resolveTaskWorktreeSync(opts) {
  try {
    const taskId = typeof opts?.taskId === 'string' && opts.taskId.trim() ? opts.taskId.trim() : null;
    if (!taskId) return null;
    const rec = worktreeService.resolveExistingSync(taskId, crewpaneHome());
    return rec ? { taskWorktree: rec.path, taskBranch: rec.branch, taskId: rec.taskId } : null;
  } catch (e) {
    // Defter okuması spawn'ı ASLA düşürmez; sessiz de kalmaz.
    logLine(`worktree çözümü başarısız (spawn izolasyonsuz devam eder): ${e.message}`);
    return null;
  }
}

/**
 * @param {object} trustedExtra B-01: main'in ÇÖZDÜĞÜ görev/worktree bağı. Yalnız
 *   main tarafından üretilir (asenkron `ensure` sonucu ya da defter okuması);
 *   `opts` üzerinden ASLA gelmez — renderer'ın yol dayatması kapalıdır (G-1).
 */
function spawnPty(win, opts = {}, trustedExtra = null) {
  const { cols = 80, rows = 24, agentId = null, department = null, label = null, images = null } = opts;
  // ADP-761 — YAPISAL ARKA DURAK: "bir ajan = bir pane" (ADP-201/487) kuralı ARTIK
  // buradan, yani pty doğuran TEK noktadan geçiyor. IPC handler'ı bunu kendisi de
  // çağırır (sıra: dedupe → plan limiti), ama IPC'yi HİÇ kullanmayan yollar
  // (restoreLivePanes, acceptRecoverablePanes, ölü-oturum fresh fallback'i,
  // resumePtyDaemon.respawnPane) eskiden yalnız kendi ad-hoc kontrollerine
  // güveniyordu. Kontrol burada olduğu için hiçbir yol atlayamaz; bilinçli ikinci
  // pane isteyen (ADP-289 karantina) `forceFresh:true` verir.
  const dedupe = dedupeSpawnForAgent(opts, 'spawnPty');
  if (dedupe) return dedupe;
  // ═══ PLAN-FIX-01 (F-4) — EŞZAMANLI AJAN TAVANI, IPC DIŞINDAKİ YOLLARDA DA ═══
  //
  // ÖLÇÜM (PLAN-GATE-R1 §6): plan kapısı YALNIZ `pty:spawn` IPC handler'ındaydı
  // (`planDenial('agents', ptys.size)`), oysa `spawnPty`'nin IPC'yi hiç kullanmayan
  // 4 çağıranı var. Sonuç bir İNİŞ kaçağıydı: Pro'dayken 8 pane açmış kullanıcı
  // Basic'e düşünce her açılışta 8 pane geri geliyor ve Basic tavanı o oturumda hiç
  // uygulanmıyordu — abonelik bitse de ürün Pro gibi çalışmaya devam ediyordu.
  //
  // 🔑 KAPI BLANKET OLAMAZ, **NİYET** SORAR. Dört çağıranın hepsine tek bir kapı
  // koymak ödeyen kullanıcıyı YANLIŞ YERE çarptırırdı (ADR-027: bir ret kaçağı gelir
  // kaybettirir, YANLIŞ bir ret müşteri kaybettirir):
  //   • 'replace' → çıkan/ölen pane'in YERİNE doğar; net artış YOK. Üstelik çıkan pane
  //     hâlâ `ptys`'te olabilir → sayaç şişik → tavandayken sahte ret. **MUAF.**
  //     (ölü-oturum taze fallback'i, ADP-938 motor profili geçişi)
  //   • 'restore' → önceki oturumun pane'i geri getiriliyor. **KISITLANIR**: tavana
  //     kadar açılır, kalanı AÇILMAZ ama kaydı defterde KALIR (silinmez) ve döngü
  //     sonunda TEK nudge verilir.
  //   • 'new' (varsayılan) → kapı IPC handler'ında KALIR: `ERR_PLAN_LIMIT` fırlatma
  //     sözleşmesini renderer bekliyor (main.js `pty:spawn`). Burada ikinci kez
  //     sorulmaz — tek karar, tek kod yolu.
  const spawnIntent = opts.spawnIntent === 'restore' || opts.spawnIntent === 'replace'
    ? opts.spawnIntent
    : 'new';
  if (spawnIntent === 'restore') {
    // notify:false — nudge TEK kez, döngünün SONUNDA verilir (her pane için bir
    // bildirim açılışta kullanıcıyı bombardımana tutardı). Ret bilgisi çağırana döner.
    const restoreGate = planDenial('agents', ptys.size, { notify: false });
    if (restoreGate) {
      logLine(
        `restore: plan tavanı — pane AÇILMADI agent=${agentId ?? '-'} `
          + `(katman=${restoreGate.tier} tavan=${restoreGate.limit} canlı=${ptys.size}; kayıt defterde duruyor)`,
      );
      return { planLimited: true, paneId: null, agentId, department, denial: restoreGate };
    }
  }
  // ADP-232-C — an AGENT spawn (claude/codex — every delegation/office worker)
  // without a configured workspace root would land in HOME (agentRunner's legacy
  // fallback) and silently mis-root the worker. The engine must NOT run.
  //
  // ADP-852 (P0 MÜŞTERİ) — bu koşul eskiden `throw` ediyordu ve KULLANICI İÇİN
  // SESSİZ ÇÖKMEYDİ: renderer'ın `.catch(() => setStatus('exited'))` dalı pane'i
  // boş siyah bırakıyor, tek ipucu alt bardaki ham `workspace_not_configured`
  // dizesi oluyordu (İngilizce, teknik, eylemsiz). Ödeyen müşteri "ajan
  // terminalleri bomboş açılıyor" dedi ve haklıydı.
  //
  // Artık ADP-694'ün KANITLI kalıbı: motor HİÇ başlatılmaz, yerine rehberi basıp
  // canlı kalan (girdiyi ÇALIŞTIRMAYAN) bir tutucu pane açılır ve spawn cevabı
  // `workspaceMissing` taşır → Terminal panelin İÇİNDE Türkçe + tek-tıklık
  // kurtarma kaplamasını çizer. Kararın kendisi aşağıda, plan kurulduktan sonra
  // (`workspaceMissing`) verilir; burada yalnız NEDEN yazılı.
  // A plain shell pane keeps its established HOME default.
  // May throw on a disallowed command — intentionally NOT caught here. ADP-154 —
  // pass REPO_ROOT so an agent/department spawn (delegation + office command box)
  // resolves its cwd to the team's PROJECT dir, never HOME (where relative result
  // paths like docs/agent-results/ would fall on the floor). ADP-050/ADP-251 — the
  // delegation bridge port+token ride in as `trusted` (main-only, never via opts:
  // opts is renderer-controlled and must not forge the token) so buildSpawn binds
  // them BEFORE codex's MCP argv is built — the `-c mcp_servers.*.env` map then
  // carries the FRESH port/token instead of a stale/absent one.
  // ADP-234 — settings.departmentDirs (user's department → project-dir mapping)
  // also rides in `trusted`; read fresh per spawn so a settings edit applies to the
  // NEXT spawn without an app restart (workspaceRoot itself stays restart-gated).
  // AD-WIN-01 — WINDOWS KÖK ÇÖZÜMÜ: ajan kimliğini KOMUT SATIRINDAN çıkar.
  // ÖLÇÜLDÜ (scripts/win/adWin01CmdLineProof.cjs): npm ile kurulmuş `claude.cmd`
  // için lider komut satırı 8.520 karakter → cmd.exe'nin 8.191 tavanını 329 karakter
  // aşıyor → süreç HİÇ doğmuyor ("The command line is too long."), MCP bayrakları da
  // o satırda olduğu için lider araçsız kalıyor. Sink kimliği bir dosyaya yazar ve
  // `--append-system-prompt-file` kullanılır (aynı ölçümde 617 karaktere iner).
  // `null` dönerse (macOS, codex, ya da bayrağı tanımayan eski bir claude) bugünkü
  // satır-içi davranış BİREBİR korunur — POSIX yolunda bu blok tam anlamıyla no-op'tur.
  // LEAD-BEHAV-01 — sink artık POSIX'te de KURULUR, ama orada YALNIZ TAŞMADA kullanılır
  // (agentRunner.identityFileCarrierIsOverflowOnly): sığan pane bugünkü satır-içi bayrağı
  // bit-bit korur. Neden gerekli: ÖLÇÜLDÜ (m4-prompt-truncation.txt) — ofis tıklamasıyla
  // açılan lider prompt'u 9.732 karakter, CLI tavanı 8.000 → delegasyon talimatı CÜMLE
  // ORTASINDAN kesiliyor ve arkasındaki lider blokları kayboluyordu. Bayrağın varlığı
  // VARSAYILMAZ, `probeSupport` ile ÖLÇÜLÜR; desteklenmiyorsa sink null döner ve
  // davranış bugünküyle aynı kalır.
  const promptFileSink = (() => {
    if (!opts || opts.command !== 'claude') return null;
    try {
      const probeEnv = { ...process.env, PATH: agentRunner.augmentedPath(process.env.PATH) };
      const bin = engineInstall.resolveBinary('claude', probeEnv);
      return spawnPromptFile.createSink({
        engine: 'claude',
        bin,
        env: probeEnv,
        home: instancePaths.crewpaneHome(),
        log: logLine,
      });
    } catch (e) {
      logLine(`spawn kimliği dosya sink'i kurulamadı (${(e && e.message) || e}) → satır-içi bayrak`);
      return null;
    }
  })();

  const plan = agentRunner.buildSpawn(
    { ...opts, images },
    process.env,
    agentWorkspaceRoot,
    {
      ...(delegationBridge ? { bridge: delegationBridge.info() } : {}),
      departmentDirs: agentSettings.readSettings().departmentDirs,
      // ADP-580 — BYOK provider keys (Groq/DeepSeek/Kimi). SECRET → main-only via
      // `trusted` (never `opts`); buildSpawn binds the selected provider's key into the
      // codex pane env. Read fresh per spawn so a settings edit applies to the next launch.
      // PROV-01 — anahtar YALNIZ settings.json'da aranıyordu; kullanıcının anahtarı
      // ~/.crewpane/keys.env'de (600) durduğu için `provider:'groq'` pane'i
      // ANAHTARSIZ doğuyordu. Dosya artık YEDEK kaynak: settings.json'daki değer
      // varsa O kazanır, yoksa dosyadan doldurulur. Sır settings.json'a KOPYALANMAZ.
      providerKeys: providerKeysEnvFile.mergeProviderKeys(agentSettings.readSettings().apiKeys).keys,
      // ENG-OPENAI-COMPAT-01 — kullanıcının kendi OpenAI-uyumlu ucu. `opts` DEĞİL
      // `trusted`: bu satır bir ADRES taşır ve renderer bir pane'in nereye
      // bağlanacağını dayatamaz (providerKeys/departmentDirs emsali). Her spawn'da
      // TAZE okunur → Ayarlar'dan adres değiştirmek bir sonraki pane'e uygulanır.
      customProvider: agentSettings.readSettings().customProvider || null,
      // ADP-585/586 — kullanıcının BAĞLI entegrasyonları (Supabase/GitHub/…). Anahtar
      // `trusted` üzerinden gelir (main-only; `opts` renderer-kontrollü olduğu için
      // oradan ASLA). Resolver bu pane'in kapsamına (proje+ortam) uyan kayıtları
      // çözer; hiç kayıt yoksa boş liste → bugünkü davranış birebir korunur.
      integrations: integrationResolverOrNull(),
      // CIDX-1 — KOD İNDEKSİ (proje başına, VARSAYILAN KAPALI). `opts` DEĞİL
      // `trusted`: karar bir AYAR okumasıdır ve renderer bir pane'i kendi başına
      // "indeksli" ilan edemez (providerKeys/integrations emsali). Çözümleyici her
      // spawn'da ayarı TAZE okur → Ayarlar'dan anahtarı açmak, uygulamayı yeniden
      // başlatmadan BİR SONRAKİ pane'e uygulanır. Kapalıysa argv bit-bit değişmez.
      codeIndex: codeIndexResolverOrNull(),
      // ADP-936 — AI motoru HESAP profili (çok-hesap geçişi). `trusted`ten geçer,
      // çünkü çözülen şey bir DİZİN YOLUdur ve renderer yol veremez (providerKeys
      // emsali). Her spawn'da defter TAZE okunur → Ayarlar'dan hesap değiştirmek
      // uygulamayı yeniden başlatmadan BİR SONRAKİ pane'e uygulanır.
      engineProfiles: engineProfiles.createResolver(instancePaths.crewpaneHome()),
      // ENG-OPENCODE-DB-01 (C4) — canlı pane'lerin ÜRÜN-ÜRETİMİ yerel depo dosyaları
      // (opencode `OPENCODE_DB`). `opts` DEĞİL `trusted`: bu bir DOSYA YOLU listesidir
      // ve renderer "şu dosya açık" iddia edemez — main kendi pty defterinden ÖLÇER.
      // Kanonik dosya listedeyse ikinci pane AYRI depo alır (taze DB şema yarışı
      // kapatılır), spawn ENGELLENMEZ ve aşağıda pane'e tek satır bilgi basılır.
      liveIsolationFiles: liveIsolationFiles(),
      log: logLine, // ADP-502 — dirForDepartment'ın root-fallback'i artık loglanır
      // B-01 (§2.5 kademe-0) — görevin izole ağacı. Çağıran ASENKRON yolda zaten
      // `ensure` etmişse onun sonucu gelir; etmemişse (senkron restore/respawn
      // yolları) defterden ÇÖZÜLÜR → yarım görev aynı worktree'ye döner (H-2).
      // `opts` DEĞİL `trusted`: bu bir DİZİN YOLUdur ve renderer yol veremez (G-1).
      ...(trustedExtra && trustedExtra.taskWorktree ? trustedExtra : resolveTaskWorktreeSync(opts) || {}),
      // AD-WIN-01 — kimlik dosyası sink'i (yukarıda kuruldu). `opts` DEĞİL `trusted`:
      // ürettiği şey bir DİZİN/DOSYA YOLUdur ve renderer yol dayatamaz (G-1).
      ...(promptFileSink ? { promptFile: promptFileSink } : {}),
    },
  );
  // ENG-08 — MOTOR API ANAHTARI (yalnız `auth.apiKey` beyan eden motorlarda).
  // Abonelik yolu olmayan bir motor pane'de ancak anahtarını ENV'de bulursa koşar.
  // ⚠️ İki çizgi: (1) anahtar ENV'e girer, ARGV'ye ASLA (agentRunner.js:1520-1525
  // emsali — argv `ps` çıktısında görünür); (2) kullanıcının KENDİ ortamındaki değer
  // EZİLMEZ (`!plan.env[k]`) — dışarıdan export edilmiş bir anahtar hep üstündür.
  // Kayıtlı iki motorda `apiKey: null` olduğu için bu blok BUGÜN hiçbir şey yapmaz;
  // ölçülebilir olsun diye `maskedNew` satırından ÖNCE duruyor (jeton maskeye girsin).
  if (plan.isAgent) {
    try {
      for (const [k, v] of Object.entries(engineAuth.apiKeyEnvFor(plan.key, { apiKeyStore: engineKeyStore(), env: process.env }))) {
        if (!plan.env[k]) plan.env[k] = v;
      }
    } catch (e) {
      logLine(`engine api-key env skipped: ${engineAuth.maskSecrets(String(e && e.message))}`);
    }
  }
  // ADP-586 — bu spawn'a enjekte edilen entegrasyon anahtarlarını maskeleme defterine
  // al: pane çıktısı/log/notify artık jetonu düz basamaz (`env` komutu dahil).
  const maskedNew = secretRedactor.registerEnv(plan.env);
  if (maskedNew) logLine(`integrations: ${maskedNew} anahtar maskeleme kapsamına alındı`);
  const paneId = `pane-${++paneSeq}`;
  // ADP-936 — HANGİ HESAPLA açıldığı GÖRÜNÜR olsun. [[adp723-launchctl-env-channel-collapse]]
  // dersi: sessiz koruma = ölçülemeyen koruma. Yalnız VARSAYILAN DIŞI profilde satır
  // basılır (varsayılanda log da bugünküyle bit-bit aynı kalır). Log'a yalnız profil
  // KİMLİĞİ girer — dizin yolu ya da jeton ASLA.
  // ACCT-FIX-01 — satır artık PANE'İN çözülen profilini basar (buildSpawn'ın env'e
  // yazdığıyla aynı çözüm), defterdeki "aktif"i değil: ikisi ayrışabilir (§3.4).
  if (plan.isAgent) {
    const paneProfile = plan.engineProfileId
      || engineProfiles.activeProfileId(instancePaths.crewpaneHome(), plan.key);
    if (paneProfile && paneProfile !== engineProfiles.DEFAULT_PROFILE_ID) {
      logLine(`engine account: paneId=${paneId} engine=${plan.key} profile=${paneProfile}`);
    }
  }
  // ENG-OPENCODE-DB-01 (C4) — İKİZ PANE AYRI DEPOYLA AÇILDI: kullanıcıya TEK SATIR.
  // Sessiz kayıp yasağı (OC-DESIGN-0919 §4-2): aynı ajanın ikinci pane'i kendi
  // deposuyla açılır; bunu yalnız log görürse kullanıcı "önceki konuşmam nerede"
  // diye sorar. Satır pane tamponuna spawn ANINDA ekilir (restoreSeedText emsali):
  // motor çıktısından önce durur, reload/pop-out'ta attach ile geri gelir. Ölçüldü:
  // opencode TUI açılışta alternatif ekrana geçer (`?1049h`) → satır TUI süresince
  // gizlenir, çıkışta/kapanışta normal ekranla geri gelir; log satırı her zaman var.
  // Yol adı satıra GİRMEZ ([[feedback_ui_copy_no_internals]]) — yalnız ne olduğu.
  let isolationNotice = '';
  if (plan.isolation && plan.isolation.separated) {
    logLine(
      `pane izolasyonu İKİZ paneId=${paneId} engine=${plan.key} agentId=${agentId ?? '-'} ` +
        `→ ayrı depo (${path.basename(path.dirname(plan.isolation.file))}); canlı ikizi ${plan.isolation.twinOf}`,
    );
    isolationNotice = `\x1b[2m${appI18n.t('main.pane.isolationTwin.line')}\x1b[0m\r\n`;
  }

  // ADP-048 — pre-accept the workspace-trust dialog for the spawn cwd so the pane opens
  // straight at the prompt (the dialog would otherwise eat the first typed message).
  // Best-effort + Eren-approved.
  // ENG-07 L2 — koşul motor ADI değil DESCRIPTOR: `plan.trust.pending` yalnız güven
  // defteri KULLANICI ev dizininde olan motorlarda true'dur (claude ~/.claude.json);
  // motorun kendi ev dizinindeki defterler (codex $CODEX_HOME) buildSpawn içinde
  // yazılmıştır (`applied:true`) çünkü o dizini hesap profili belirler.
  if (plan.trust && plan.trust.pending) {
    const trusted = agentRunner.ensureEngineTrusted(plan.key, plan.cwd, plan.env);
    logLine(`${plan.key} trust ensured paneId=${paneId} cwd=${plan.cwd} ok=${trusted}`);
  }

  // ENG-07 (ENG-R3 §2.3) — EKSİK YETENEKLER LOG'A DÜŞER. "Sessizce daha az yetenek"
  // yasağının operatör tarafındaki yüzü: bir pane kimliksiz/bloksuz/board'suz açıldıysa
  // bu satır onu SÖYLER. Güvenlik-kritik kayıplar (kimlik, alt-ajan bloğu, mcp, trust)
  // ayrıca işaretlenir — ADR-004'ün sert katmanının kaybı "bilgi" değil UYARI'dır.
  if (plan.capabilities && plan.capabilities.summary) {
    const security = plan.capabilities.unsupported.filter((i) => i.severity === 'security');
    logLine(
      `pane capabilities paneId=${paneId} engine=${plan.capabilities.engine} ${plan.capabilities.summary}` +
        (security.length ? ` · GÜVENLİK: ${security.map((i) => `${i.capability}(${i.state})`).join(', ')}` : ''),
    );
  }

  // ENG-10 — AYNI BEYANIN KULLANICI DİLİ. `plan.capabilities.unsupported` mühendis
  // listesidir (`hooks`, `extraRoots`, `mcp.envInheritance`…); kullanıcı "bu ajan NE
  // YAPAMAZ?" diye sorar. Matris o çeviriyi descriptor'ın KENDİ gerekçeleriyle yapar
  // (uydurma metin yok) ve pane kaydında yaşar → ofis/ayarlar/hub rozetlerinin kaynağı.
  // Kabuk pane'inde `plan.capabilities` zaten null → matris de yok, rozet çizilmez.
  const paneCapabilities = plan.capabilities
    ? { ...plan.capabilities, matrix: paneCapabilityMatrix.buildMatrix(plan.capabilities.engine) }
    : null;
  if (paneCapabilities && paneCapabilities.matrix) {
    const userSummary = paneCapabilityMatrix.summarizeMatrix(paneCapabilities.matrix);
    if (userSummary) logLine(`pane capability matrix paneId=${paneId} ${userSummary}`);
  }

  // ADP-201 — give AGENT panes the office Supabase (public URL + anon key) so the Task Board
  // MCP (crewpane-task-mcp.cjs) can read/write the board in the PACKAGED app (where .env.local
  // is absent). Only agent CLIs.
  //
  // BOARD-AUTH-01 (P0, ÖLÇÜLDÜ 03.09) — ⛔ "MEVCUT DEĞERİ EZME" KURALI KALDIRILDI.
  // Eski satır `if (!plan.env[k]) plan.env[k] = v;` idi: pane, ortamdan MİRAS GELEN
  // bir `NEXT_PUBLIC_CREWPANE_SUPABASE_*` üçlüsünü main'in KARARINA tercih ediyordu.
  // Ölçülen vaka: dev DMG, PROD ofisin bir pane'inden başlatıldı; o pane'in env'i
  // (aynı bu blok tarafından) PROD çiftini taşıyordu. main o çifti KENDİSİ İÇİN
  // reddetti (`[backend] dev kanalında YEREL hedef reddedildi
  // (live_target_ignored_in_packaged_dev_build)`) ama ajan pane'ine AYNEN devretti.
  // Sonuç: task MCP PROD PostgREST'e, `/app-db/token` ise DEV projesinin kullanıcı
  // JWT'sini verdi → her board çağrısı `PGRST301 No suitable key or wrong key type`.
  // Lider "Task Board erişilemiyor (kimlik doğrulama / JWT hatası)" dedi ve görev
  // açamadı; `crewpane-delegate` (PostgREST'e HİÇ dokunmaz) çalışmaya devam etti.
  //
  // KURAL: hedefi main ÇÖZER, pane ONA UYAR. `publicSupabaseEnv()` zaten üç kademeyi
  // (process.env → .env.local → makine dosyası) OKUYOR ve kanal kuralını onların
  // ÜSTÜNE uyguluyor (backendTarget) — yani geliştiricinin açık ezmesi hâlâ geçerli,
  // AMA yalnızca çözümleyicinin onayladığı kadar. Ortamın çözümleyiciyi atlaması bu
  // satırdan sonra mümkün değil. Çözümleme boş dönerse (`{}`) miras alınan değere
  // DOKUNULMAZ — bugünkü "yapılandırma yok" yolu bit-bit korunur.
  if (plan.isAgent) {
    const sb = publicSupabaseEnv();
    for (const [k, v] of Object.entries(sb)) {
      if (plan.env[k] && plan.env[k] !== v) {
        logLine(`[backend] pane env EZİLDİ (${k}): miras=${k.endsWith('URL') ? plan.env[k] : '<gizli>'} → main kararı`);
      }
      plan.env[k] = v;
    }
  }

  // ADP-565 (Faz 5 — OTORİTER görünürlük) — pane'in EFEKTİF launch modeli. Biz
  // `--model` ile ne başlattıysak (plan.model) chip'in OTORİTER kaynağıdır: K1
  // config-read (`--model` verildiğinde flag'i GÖRMEZ, config'i okur → yanlış chip)
  // yalnız model VERİLMEDİĞİNDE fallback'tir. plan.model null ise bugünkü K1 davranışı.
  const launchModel = plan.isAgent ? plan.model || null : null;
  // AGENT-MODEL-01 — bu pane'e GERÇEKTEN basılan efor. `buildSpawn` bunu zaten
  // döndürüyordu (descriptor beyaz listesinden geçmiş değer) ama okunmuyordu →
  // rozet eforu hiç göremiyordu. null = bayrak eklenmedi = motorun kendi varsayılanı.
  const launchEffort = plan.isAgent ? plan.effort || null : null;
  // ADP-526 (K1) — spawn anında engine config'inden model etiketi (yalnız launchModel
  // yoksa): claude settings.json/ANTHROPIC_MODEL, codex config.toml. Bilinemiyorsa null.
  // ADP-580 — a codex custom provider (Groq/DeepSeek/Kimi) yields a provider-aware chip
  // ("Groq · Llama 3.3 70B"); labelForModelId alone would show the raw model id.
  // HATA-07 — kural artık modelDetect.paneModelLabel'da (saf + `node --test` ile
  // sınanır): launch modeli VARSA rozet ondan türer, K1 config-okuması YALNIZ model
  // verilmediğinde fallback'tir. Satır-içi üçlü koşulun yerini aldı — davranış aynı,
  // fark: kural artık bir kapıdan geçiyor ve bayat-rozet regresyonu teste bağlandı.
  const modelLabel = modelDetect.withEffortSuffix(
    modelDetect.paneModelLabel(
      { isAgent: plan.isAgent, launchModel, provider: plan.provider },
      {
        // ENG-OPENAI-COMPAT-01 — kullanıcının kendi ucu da rozette ADIYLA görünsün
        // ("Kendi Ucum · gpt-4o-mini"); satır verilmezse rozet ham model id'sine düşerdi.
        providerModelLabel: (p, m) =>
          providers.providerModelLabel(p, m, agentSettings.readSettings().customProvider || null),
        resolveK1: () => modelDetect.resolveSpawnModel({ engine: plan.key, env: plan.env, cwd: plan.cwd }),
      },
    ),
    // AGENT-MODEL-01 — efor rozete İDDİA değil ÖLÇÜM olarak girer (argv'ye basılan değer).
    launchEffort,
  );
  if (launchModel) logLine(`model launched (--model) paneId=${paneId} engine=${plan.key} model=${launchModel} label=${modelLabel}`);
  if (launchEffort) logLine(`effort launched paneId=${paneId} engine=${plan.key} effort=${launchEffort}`);
  else if (modelLabel) logLine(`model resolved (K1) paneId=${paneId} engine=${plan.key} label=${modelLabel}`);

  // ── ADP-694 · MOTOR CLI ÖN-KONTROLÜ (P0: sessiz ölümü kapat) ───────────────
  // ÖLÇÜLDÜ: motor CLI PATH'te yokken node-pty exec'i başarısız olur ve çocuk
  // `exit code 1 + SIFIR bayt` ile ölür → pty:exit → TerminalPanel.closeCell →
  // hücre yok olur. Kullanıcı ajana tıklar, HİÇBİR ŞEY olmaz (ADP-615 §4).
  //
  // Kontrol tam olarak node-pty'nin kullanacağı env'e (plan.env — buildSpawn'ın
  // PATH huninisinden geçmiş) bakar; engineCheck'in login-shell probu burada
  // kullanılamaz (async + FARKLI PATH). Eksikse motor HİÇ başlatılmaz: yerine
  // rehberi basıp canlı kalan, girdiyi ÇALIŞTIRMAYAN bir tutucu açılır.
  // ADP-833 — çözülen YOL artık atılmıyor: Windows'ta motorun kendisi `claude.cmd`
  // olabilir (npm yolu) ve bir batch dosyası ne CreateProcess ne node-pty tarafından
  // kabuksuz çalıştırılabilir → `execArgs` onu `cmd.exe /d /s /c` ile sarar.
  // macOS'ta `execArgs` girdiyi AYNEN döndürür (spawn hattı bit-bit aynı).
  // ADP-852 — ÇALIŞMA ALANI ÖN KOŞULU, motor ön koşulundan ÖNCE gelir: kök yoksa
  // motorun kurulu olup olmaması kullanıcı için henüz ilgisizdir (motor kurulsa bile
  // ajan köksüz başlayamaz). Bu yüzden `workspaceMissing` `engineMissing`i BASTIRIR —
  // tek ekranda tek soru sorulur, kullanıcı iki kaplama arasında sekmez.
  const workspaceMissing = plan.isAgent && !agentWorkspaceRoot;
  const resolvedBin = plan.isAgent && !workspaceMissing ? engineInstall.resolveBinary(plan.file, plan.env) : null;
  const engineMissing = plan.isAgent && !workspaceMissing && !resolvedBin ? plan.key : null;
  // ENG-16 — bedava satıcı kapısı ürün ayarıyla kapatılmış olabilir. `readSettings`
  // patlarsa kapı AÇIK kalır (fail-open): bir ayar okuma hatası kullanıcıyı çalışan
  // bir motordan etmemeli.
  let vendorGate = { blocked: false, policy: null, reason: null, banner: null };
  if (plan.isAgent && !workspaceMissing && !engineMissing) {
    try {
      vendorGate = engineBilling.vendorGateVerdict(plan.key, { settings: agentSettings.readSettings(), env: plan.env });
    } catch {
      vendorGate = { blocked: false, policy: null, reason: 'ayar okunamadı → kapı açık', banner: null };
    }
  }
  // ── ENG-OPENCODE-PROVIDER-01 · MODEL ÖN-DOĞRULAMA KAPISI (OC-DESIGN-0919 §6-B) ──
  // NEDEN. ÖLÇÜLDÜ (RESEARCH-OC-01 07-model-fallback.txt): opencode'a listede
  // OLMAYAN bir model adı verilince motor turu makinede giriş yapılmış ilk BULUT
  // sağlayıcıya sessizce gönderdi (~8k jeton Eren'in OpenAI hesabına). "Kod dışarı
  // çıkmasın" diye yerel model seçen müşteri için gizlilik ihlali. Kapı spawn'dan ÖNCE:
  // model `opencode models` listesinde yoksa, sağlayıcı adresi karar 1 politikasını
  // (LAN http yalnız onayla, internet http sert ret) geçmiyorsa ya da uç 3 sn'de cevap
  // vermiyorsa motor HİÇ başlatılmaz, yerine ne olduğunu iki dilde anlatan tutucu pane
  // açılır (ADP-694 / vendorGate ile aynı kalıp).
  //
  // 🔒 Bu dal MOTOR ADINA bakmaz: kapı yalnız descriptor'ı `modelGate` beyan eden
  // motorda koşar; ölçüm yapılamadığında (ikili yok, zaman aşımı) KAPANMAZ (fail-open
  // + log — "motor kurulu ama koşmuyor" arızası doğurmamak için).
  // Asenkron IPC yolu (`pty:spawn`) hükmü `preflight` ile ÖN-ISITIR ve `trustedExtra`
  // ile getirir (erişilebilirlik probu yalnız orada); senkron yollarda (restore/respawn)
  // liste+config burada senkron ölçülür (60 sn önbellek), probe atlanır ve log söyler.
  // Getirilen hüküm yalnız AYNI model + AYNI cwd içinse kullanılır (proje config'i cwd'ye bağlı).
  let modelGate = { blocked: false, reason: 'skipped', banner: null };
  if (plan.isAgent && !workspaceMissing && !engineMissing && !vendorGate.blocked) {
    try {
      const pre = trustedExtra && trustedExtra.modelGate;
      modelGate = pre && pre.model === plan.model && pre.cwd === plan.cwd
        ? pre
        : opencodeModelGate.verdictSync({
          descriptor: engineRegistry.getEngine(plan.key),
          model: plan.model,
          bin: resolvedBin,
          env: plan.env,
          cwd: plan.cwd,
          settings: agentSettings.readSettings(),
          t: appI18n.t,
          locale: appI18n.getLocale(),
          label: (engineInstall.installInfo(plan.key) || {}).label || plan.key,
        });
    } catch (e) {
      // Ölçüm hatası kapıyı KAPATMAZ (fail-open) — ama sessiz de kalmaz.
      modelGate = { blocked: false, reason: 'unmeasured', detail: `throw: ${e && e.message}`, banner: null };
    }
    if (modelGate.reason !== 'no-model' && modelGate.reason !== 'not-gated') {
      logLine(
        `model gate paneId=${paneId} engine=${plan.key} model=${plan.model || '-'} sonuç=${modelGate.reason}` +
          (modelGate.detail ? ` (${modelGate.detail})` : '') +
          (modelGate.url ? ` adres=${modelGate.url}` : '') +
          (modelGate.probe ? ` probe=${modelGate.probe}` : '') +
          (modelGate.blocked ? ' → motor başlatılmadı, rehber pane\'i açılıyor' : ''),
      );
    }
  }
  const installGuide = engineMissing ? engineInstall.installInfo(engineMissing) : null;
  let spawnFile = plan.file;
  let spawnArgv = plan.argv;
  if (!engineMissing && !workspaceMissing && resolvedBin && process.platform === 'win32') {
    const target = engineInstall.execArgs(resolvedBin, plan.argv);
    spawnFile = target.file;
    // ADP-893 — node-pty'ye DİZİ vermek sarmalayıcıyı YOK EDER. `argsToCommandLine`
    // (winpty'den kopya, MSDN kuralı) her elemanı yeniden kaçışlar: bizim önceden
    // kurduğumuz `""codex.cmd" "login""` dizesindeki tırnaklar `\"` olur ve cmd.exe
    // `\"` diye bir kaçış TANIMAZ → komut adı `\"codex.cmd\"` olur, pane saniyesinde
    // ölür (ADP-893 semptom 1). ÖLÇÜLDÜ (gerçek node-pty, bu repo):
    //   dizi  → cmd.exe /d /s /c \"\"C:\Program Files\npm\codex.cmd\" \"login\"\"
    //   dize  → cmd.exe /d /s /c ""C:\Program Files\npm\codex.cmd" "login""
    // node-pty args'ı DİZE alırsa onu "önceden kaçışlanmış CommandLine" sayar ve
    // dokunmaz (windowsPtyAgent.ts:255-261) → batch dalında dizeyi veriyoruz.
    // `execArgs` bu alanı YALNIZ win32-batch dalında döndürür; macOS'ta undefined'dır
    // ve bu blok zaten hiç koşmaz → POSIX spawn hattı bit-bit aynı.
    spawnArgv = target.commandLine || target.argv;
  }
  if (workspaceMissing) {
    // Motor HİÇ başlatılmaz — ADP-694 tutucusunun AYNISI (girdiyi çalıştırmayan
    // printf+sleep süreci). Banner, kaplamanın YEDEĞİDİR: kaplama kapatılsa,
    // pane pop-out edilse, ekran görüntüsü alınsa ya da mobil defterden okunsa
    // bile kullanıcı ne olduğunu ve ne yapacağını görür.
    const holder = engineInstall.guidanceHolderArgv(
      workspaceOnboarding.missingWorkspaceBanner({ defaultDir: workspaceOnboarding.defaultWorkspaceDir() }),
    );
    spawnFile = holder.file;
    spawnArgv = holder.argv;
    logLine(
      `workspace MISSING paneId=${paneId} command=${plan.key} agentId=${agentId ?? '-'} ` +
        `→ çalışma alanı rehberi pane'i açılıyor (motor başlatılmadı)`,
    );
  } else if (engineMissing) {
    const holder = engineInstall.guidanceHolderArgv(engineInstall.missingEngineBanner(engineMissing));
    spawnFile = holder.file;
    spawnArgv = holder.argv;
    logLine(
      `engine MISSING paneId=${paneId} engine=${engineMissing} file=${plan.file} ` +
        `agentId=${agentId ?? '-'} → kurulum rehberi pane'i açılıyor (motor başlatılmadı)`,
    );
  } else if (vendorGate.blocked) {
    // ENG-16 — SATICI KAPISI KAPALI (kullanıcı ayarı). Motor kurulu ve çalışır, ama
    // GİRİŞSİZ koştuğu için istekleri satıcının kendi sunucusundan geçecekti; ürün
    // ayarı buna izin vermiyor. Kalıp ADP-694 ile AYNI: motor HİÇ başlatılmaz, yerine
    // ne olduğunu ve ne yapılacağını anlatan tutucu pane açılır.
    // 🔒 Bu dal MOTOR ADINA bakmaz: karar `engineBilling` + descriptor beyanından
    // gelir ve ölçüm yapılamadığında (`vendorHosted === null`) KAPANMAZ (fail-open).
    const holder = engineInstall.guidanceHolderArgv(vendorGate.banner);
    spawnFile = holder.file;
    spawnArgv = holder.argv;
    logLine(
      `vendor-hosted BLOCKED paneId=${paneId} engine=${plan.key} agentId=${agentId ?? '-'} ` +
        `politika=${vendorGate.policy} sebep=${vendorGate.reason} → rehber pane'i açılıyor (motor başlatılmadı)`,
    );
  } else if (modelGate.blocked) {
    // ENG-OPENCODE-PROVIDER-01 — model listede yok / adres politikası / uç erişilemez.
    // Motor HİÇ başlatılmaz; banner pane'in İÇİNDE (kaplama yok — pop-out, ekran
    // görüntüsü ve mobil defter aynı satırı görür). Sebep yukarıdaki `model gate` satırında.
    const holder = engineInstall.guidanceHolderArgv(modelGate.banner);
    spawnFile = holder.file;
    spawnArgv = holder.argv;
  }

  // ── WIN-FIRSTRUN-01 (K1) · WINDOWS KABUK ÖN KOŞULU ───────────────────────────
  // NEDEN. Yeni Windows müşterisi (RESEARCH-WIN-01 §3): claude ~35 kez 1 sn içinde
  // `exit 1` ile öldü, hücre anında kayboldu, hiçbir metin görülemedi. claude ikilisi
  // Windows'ta açılışta bir kabuk (Git Bash ya da PowerShell) bulamazsa tek satır
  // hata basıp çıkar. Bu kapı AYNI aramayı spawn'dan ÖNCE yapar; bulamazsa motor HİÇ
  // başlatılmaz, yerine ne olduğunu ve ne yapılacağını iki dilde anlatan tutucu pane
  // açılır (ADP-694 / workspaceMissing ile aynı kalıp).
  //
  // Kapı SATICININ KAPISININ AYNASIDIR (ikiliden okundu — winShellPrereq.cjs başlığı):
  // Windows PowerShell 5.1'e de düşer, yani taze Windows 11'de KAPANMAZ; yalnız claude'un
  // kendisinin öleceği makinede kapanır. Hangi motorun tabi olduğu descriptor beyanından
  // (`install.win32Shell`) gelir, motor adından değil. macOS/Linux'ta hüküm her zaman
  // açıktır (platform dalı `not-win32` ile döner; spawn hattı bit-bit aynı).
  // Kontrol kolu: `CREWPANE_WIN_SHELL_PRECHECK=0` → kapı hiç bakmaz.
  let shellMissing = null;
  if (plan.isAgent && !workspaceMissing && !engineMissing && !vendorGate.blocked && !modelGate.blocked) {
    let shellVerdict = { blocked: false, reason: 'skipped' };
    try {
      shellVerdict = winShellPrereq.shellPrereqVerdict({
        engineId: plan.key,
        env: plan.env,
        platform: process.platform,
        enabled: crewpaneEnv.readEnv(winShellPrereq.PRECHECK_ENV_BASE) !== '0',
        descriptor: engineRegistry.getEngine(plan.key),
      });
    } catch (e) {
      // Ölçüm hatası kapıyı KAPATMAZ (fail-open) — ama sessiz de kalmaz.
      logLine(`win shell precheck failed-open paneId=${paneId} engine=${plan.key}: ${e && e.message}`);
    }
    if (shellVerdict.blocked) {
      const label = (engineInstall.installInfo(plan.key) || {}).label || plan.key;
      shellMissing = { engine: plan.key, label, reason: shellVerdict.reason, docsUrl: shellVerdict.docsUrl };
      const holder = engineInstall.guidanceHolderArgv(
        winShellPrereq.missingShellBanner(shellVerdict, { t: appI18n.t, locale: appI18n.getLocale(), label }),
      );
      spawnFile = holder.file;
      spawnArgv = holder.argv;
      logLine(
        `win SHELL MISSING paneId=${paneId} engine=${plan.key} agentId=${agentId ?? '-'} ` +
          `sebep=${shellVerdict.reason} → kabuk rehberi pane'i açılıyor (motor başlatılmadı)`,
      );
    } else if (process.platform === 'win32') {
      logLine(`win shell precheck paneId=${paneId} engine=${plan.key} sonuç=${shellVerdict.reason}`);
    }
  }

  // ── AD-WIN-01 · KOMUT SATIRI UZUNLUK KAPISI ──────────────────────────────────
  // NEDEN. Cihan'ın (Windows 11) lider pane'i bugüne kadar SESSİZCE sakat doğdu:
  // cmd.exe "The command line is too long." yazıp çıkıyor, ama uygulama pane'i
  // "açıldı" sayıyor → kullanıcı boş bir terminale bakıyor, destek de HATA
  // ARAMIYOR çünkü hiçbir yere hata düşmüyor. Bu kapı o sessizliği kapatır:
  // taşma KESİNSE motor HİÇ başlatılmaz, yerine ne olduğunu ve ne yapılacağını
  // Türkçe anlatan tutucu pane açılır (ADP-694 / workspaceMissing ile aynı kalıp).
  //
  // Kapı YALNIZ KESİN taşmada kapanır (`fits === false`); ölçüm yapılamazsa
  // `commandLineVerdict` `fits:true` döner → çalışan hiçbir spawn engellenmez.
  // macOS'ta sınır 256 KB'lık güvenli tabandır ve ölçülen en uzun canlı komut
  // satırı 8.509 karakterdir → bu dal orada asla koşmaz (davranış bit-bit aynı).
  const cmdVerdict = cmdLineLimit.commandLineVerdict({
    file: spawnFile,
    argv: spawnArgv,
    platform: process.platform,
    env: plan.env,
  });
  if (!cmdVerdict.fits) {
    logLine(
      `KOMUT SATIRI ÇOK UZUN paneId=${paneId} engine=${plan.key} agentId=${agentId ?? '-'} ` +
        `uzunluk=${cmdVerdict.length} sınır=${cmdVerdict.limit} (${cmdVerdict.limitName}) ` +
        `taşma=${cmdVerdict.overBy} dal=${cmdVerdict.kind} → motor başlatılmadı, rehber pane'i açılıyor`,
    );
    // Kurulum komutu TEK KAYNAKTAN (engineInstall kataloğu, platforma göre çözülür):
    // cmdLineLimit motor kataloğunu bilmez, ikinci bir gerçek üretmeyiz.
    const holder = engineInstall.guidanceHolderArgv(
      cmdLineLimit.tooLongBanner(cmdVerdict, engineInstall.installInfo(plan.key) || {}),
    );
    spawnFile = holder.file;
    spawnArgv = holder.argv;
  }

  const child = pty.spawn(spawnFile, spawnArgv, {
    name: 'xterm-color',
    cols,
    rows,
    cwd: plan.cwd,
    env: plan.env,
  });
  logLine(
    `pty spawned paneId=${paneId} pid=${child.pid} command=${plan.key} ` +
      `agentId=${agentId ?? '-'} dept=${department ?? '-'} file=${spawnFile} ` +
      // ADP-694 — rehber pane'inde argv banner script'idir (ANSI + satır sonu içerir):
      // log satırını bozmasın diye tek sözcükle özetlenir; ayrıntı `engine MISSING` satırında.
      `argv=[${engineMissing ? '<motor-kurulum-rehberi>' : shellMissing ? '<kabuk-rehberi>' : modelGate.blocked ? '<model-kapisi-rehberi>' : plan.argv.join(' ')}] ` +
      `cwd=${plan.cwd} cols=${cols} rows=${rows} ` +
      // ADP-087 (ADR-007 Faz 1) — record the minted claude session id so a later
      // limit capture can resume by id. Foundation only; no resume is triggered.
      `sessionId=${plan.sessionId ?? '-'}`,
  );

  let dataBytes = 0;
  child.onData((rawData) => {
    // ADP-586 (Kural 4) — pane çıktısındaki entegrasyon anahtarı MASKELENİR. Sır
    // pane env'inde yaşıyor (ADP-585'in kabul edilmiş riski), dolayısıyla ajanın
    // `env`/`printenv` çıktısı ya da bir MCP server'ın hata mesajı jetonu ekrana
    // basabilir; oradan da tampona, replay'e, mobil ekrana ve ekran görüntüsüne
    // geçerdi. Maskeleme EN BAŞTA yapılır → aşağıdaki tüm tüketiciler (renderer,
    // entry.buffer, VT ekranı, model sniffer) maskeli baytı görür.
    // BİLİNEN SINIR (v1): sır TAM OLARAK iki chunk'a bölünürse bu chunk'ta eşleşme
    // olmaz; defter boşken (entegrasyonu olmayan kullanıcı) çağrı no-op'tur.
    const data = secretRedactor.redact(rawData);
    if (AUTOTEST && dataBytes === 0) logLine(`pty first data paneId=${paneId} (${data.length} bytes)`);
    dataBytes += data.length;
    // Status hook (ADP-014 bridge): record last-activity so list() can derive
    // working/idle without the renderer round-tripping.
    const entry = ptys.get(paneId);
    let seq = dataBytes;
    if (entry) {
      entry.lastDataAt = Date.now();
      // ASK-CARD-01 — sessizlik penceresini yeniden kur (ucuz: ekran BURADA okunmaz;
      // pane sustuktan QUIET_MS sonra runtime VT ekranına bir kez bakar).
      if (entry.agentId) paneAskRuntime.noteData(paneId);
      // WIN-FIRSTRUN-01 (K3) — İLK CHUNK: pty artık "hazır"; bekletilen resize varsa
      // ŞİMDİ, try/catch İÇİNDE uygulanır. Motor bu ana kadar öldüyse node-pty (win32)
      // yine "already exited" fırlatır ama artık YAKALANIR — PROD-48'in uncaught'u buydu.
      // POSIX'te `pendingResize` hiç dolmaz (ptyResizeGate), bu dal no-op'tur.
      if (!entry.firstDataAt) {
        entry.firstDataAt = entry.lastDataAt;
        const pendingResize = ptyResizeGate.takePendingResize(entry);
        if (pendingResize) {
          try {
            entry.child.resize(pendingResize.cols, pendingResize.rows);
            entry.screen?.resize(pendingResize.cols, pendingResize.rows);
            logLine(`pty resize (deferred→applied) paneId=${paneId} cols=${pendingResize.cols} rows=${pendingResize.rows}`);
          } catch (err) {
            logLine(`pty resize skipped (dead pane, deferred) paneId=${paneId}: ${err.message}`);
          }
        }
      }
      // ADP-028 — accumulate cumulative byte count + rolling replay buffer.
      entry.bytes += data.length;
      seq = entry.bytes;
      // ADP-586 — tamponda İKİNCİ tarama: sır iki chunk'a bölündüyse chunk-başına
      // maskeleme onu kaçırır, ama BİRİKMİŞ tamponda bütün hâlde durur (pane replay,
      // delegasyon anlık görüntüsü ve mobil son-satır bu tampondan okur). Yalnız
      // tamponun sonu taranır (maliyet chunk boyutuyla orantılı, tamponla değil).
      // PERF-BG-01 — TAVANI HER CHUNK'TA DEĞİL, PAY DOLUNCA UYGULA. `slice()` V8'in
      // birleştirilmiş (cons) dizesini DÜZLEŞTİRİR: her chunk'ta 256 KB'lık tam bir
      // kopya demekti (ölçüldü: 1.800 chunk = 60 sn'lik tek pane akışı → 61 ms ana
      // süreç CPU'su; paylı sürüm 4,2 ms — 15×). Tampon artık tavanı PAY kadar
      // aşabilir ve ancak o zaman kırpılır; SÖZLEŞME AYNI: kırpma sonrası uzunluk
      // yine tam olarak PANE_BUFFER_MAX'tır, replay/attach bunu okur.
      let nextBuffer = entry.buffer + data;
      if (nextBuffer.length > PANE_BUFFER_MAX + PANE_BUFFER_SLACK) {
        nextBuffer = nextBuffer.slice(-PANE_BUFFER_MAX);
      }
      entry.buffer = secretRedactor.redactTail(nextBuffer, data.length);
      // ADP-526 (K2) — çıktıda model adı geçerse chip'i düzelt (oturum ortası /model
      // dahil). push() sözleşme gereği ASLA throw etmez (ADP-335: onData'da kaçan
      // hata app'i öldürür); renderer 1.5s pty:list poll'unda yeni etiketi görür.
      if (entry.modelSniffer) {
        const detected = entry.modelSniffer.push(data);
        // AGENT-MODEL-01 — K2 yalnız MODELİ görür (banner'da efor yazmaz). Ham
        // tespiti doğrudan yazmak, launch eforunu rozetten SİLERDİ (kullanıcı
        // xhigh seçmiş, oturum içi /model sonrası rozet sessizce "Sonnet"e döner).
        // Sonek burada yeniden kurulur — efor bir LAUNCH bayrağıdır, değişmez.
        const withEffort = modelDetect.withEffortSuffix(detected, entry.launchEffort);
        if (withEffort && withEffort !== entry.modelLabel) {
          entry.modelLabel = withEffort;
          logLine(`model detected (K2) paneId=${paneId} label=${withEffort}`);
        }
      }
    }
    // agentId travels with the data so the office sync (ADP-014) can route
    // bytes → sprite without a separate paneId→agentId lookup. `seq` is the
    // post-chunk cumulative byte count (ADP-028 attach dedupe).
    // ADP-593 — sahip pencereye VE (varsa) bu pane'in pop-out penceresine yayın.
    // ADP-905 — sahip pencere ÖLMÜŞ olabilir (macOS'ta pencere kapatıldı, pty yaşadı):
    // hedef her chunk'ta GÜNCEL pencereden çözülür, yoksa geri gelen pencere sessiz kalırdı.
    sendPaneEvent(paneOwnerWindow(entry, win), paneId, 'pty:data', { paneId, agentId, data, seq });
    // ADP-293/ADP-324 — mobil okuma kanalı: ham bayt VT ekranına yazılır; SSE olaylarını
    // ekranın kendisi üretir (kesinleşen satır → seq'li 'pane'; ilerleme satırı → live).
    // Eskiden burada her CHUNK için cleanPaneTail(data, 1) çağrılıyordu: chunk sınırı satır
    // sınırı değil + TUI '\n' basmıyor → mobilde 175 KB'lık TEK SATIR (ADP-323 §A).
    if (entry && entry.screen) entry.screen.write(data);
  });
  child.onExit(({ exitCode, signal }) => {
    logLine(`pty exit paneId=${paneId} code=${exitCode} signal=${signal ?? '-'}`);
    // ASK-CARD-01 — açık karar kartı varsa kapanır ('gone'): ölü pane'e cevap yazılmaz.
    try { paneAskRuntime.noteExit(paneId); } catch { /* best-effort */ }
    // ── OBS-02 — ÜÇÜNCÜ YÜZEY: WORKER PANE ───────────────────────────────────
    // Bir çalışanın motoru (claude/codex) sıfırdan farklı kodla ölürse bugün bunu
    // yalnız o pane'e BAKAN insan görür; ekranı kapalıysa kimse görmez. Artık
    // Sentry'ye UYARI (error değil) olarak düşer: uygulama sağlam, işi yapan süreç
    // düştü — alarmı hak eden ama "uygulama bozuk" demeyen bir olay.
    //
    // GÜRÜLTÜ KAPILARI (üçü de kasıtlı bitişleri eler):
    //   • exitCode === 0        → iş bitti, normal.
    //   • signal var            → biz öldürdük (pane X'i, paneKill, reaper).
    //   • app.isQuitting        → uygulama kapanıyor; teardown'da ölen pane arıza
    //                             DEĞİLDİR. (ÖLÇÜLDÜ: `preserve` bayrağı yetmedi —
    //                             kapanışta `code=1 signal=0` ile ölen bir pane bu
    //                             kapıya takılmadan sahte bir uyarı üretti.)
    //   • entry.preserve        → restart-resume için saklanan pane.
    // ⚠️ Pane ÇIKTISI (buffer) BURAYA GİRMEZ: ajanın ekranı prompt ve dosya
    // içeriğidir — gönderilebilecek en tehlikeli şey. Yalnız kod + motor adı gider.
    //   • 128+N kodu       → SEN-F2: node-pty sinyal ölümünü `code=128+N, signal=0`
    //                          diye bildirir (POSIX `$?` sözleşmesi). 129 = SIGHUP =
    //                          tty/ebeveyn gitti; bu da "biz öldürdük" sınıfıdır ve
    //                          PROD-3'ün 40 olayının TAMAMI buydu.
    //   • motor adı         → SEN-F2: defter çıkıştan önce düşerse spawn planındaki
    //                          anahtar yedek kaynaktır ("motor: ?" bir telemetri açığıydı).
    // WIN-FIRSTRUN-01 (K2) — ERKEN ÖLÜM HÜKMÜ. kod≠0 + kendi kendine + spawn'dan < 5 sn
    // → renderer hücreyi KAPATMAZ, motorun bastığı baytlar ekranda kalır. Hüküm ve
    // sayılar (`msSinceSpawn`, `firstDataBytes`; 0 = motor tek bayt basmadan öldü)
    // pty:exit olayıyla renderer'a, etiket olarak Sentry'ye (K5) gider.
    let early = { early: false, reason: 'unclassified', msSinceSpawn: -1, firstDataBytes: 0 };
    try {
      const exiting = ptys.get(paneId);
      early = paneEarlyExit.classifyEarlyExit({
        exitCode,
        signal,
        quitting: app.isQuitting,
        preserve: exiting && exiting.preserve,
        msSinceSpawn: exiting && exiting.startedAt ? Date.now() - exiting.startedAt : NaN,
        bytes: exiting ? exiting.bytes : dataBytes,
      });
      if (early.early) {
        logLine(
          `pty EARLY EXIT paneId=${paneId} engine=${(exiting && exiting.command) || plan.key} code=${exitCode} ` +
            `msSinceSpawn=${early.msSinceSpawn} firstDataBytes=${early.firstDataBytes} (${early.reason}) → hücre korunur`,
        );
      }
    } catch { /* sınıflandırma pane yaşam döngüsünü etkileyemez */ }
    try {
      const exiting = ptys.get(paneId);
      const verdict = paneExitClassifier.classifyPaneExit({
        exitCode,
        signal,
        quitting: app.isQuitting,
        preserve: exiting && exiting.preserve,
        engine: exiting && exiting.command,
        plannedEngine: plan && plan.key,
      });
      if (verdict.report) {
        reportModuleFault({
          module: 'worker',
          label: 'pane-exit',
          message: verdict.message,
          location: null,
          stopped: false,
          level: verdict.level,
          at: Date.now(),
          // WIN-FIRSTRUN-01 (K5) — Sentry ETİKETLERİ: "ilk çıktıdan önce mi öldü" sorusu
          // artık yarış tesadüfüne (PROD-48) değil sayıya bakar. Mesaj DEĞİŞMEZ
          // (parmak izi/gruplama korunur); sayılar etikettir, serbest metin yok.
          engine: verdict.engine,
          msSinceSpawn: early.msSinceSpawn,
          firstDataBytes: early.firstDataBytes,
        });
      }
    } catch { /* hata takibi pane yaşam döngüsünü etkileyemez */ }
    // D-07 (K4) — HAFIZA KULLANIM DEFTERİNİ KAPAT. Oturum bitti: bu pane'e enjekte
    // edilen kayıtların transkriptte GEÇİP GEÇMEDİĞİ şimdi ölçülebilir. Sonuç bir
    // sonraki seçkinin skorunu düşürür (kullanılmayan kayıt tekrar tekrar binmesin).
    settleMemoryUsage({ paneId });
    // ADP-659 — pane ölümü EN GÜÇLÜ tamamlanma sinyallerinden biri; tick'i bekleme.
    // (Renderer'ın kendi onExit dinleyicisi reload'da kaybolur, bu kaybolmaz.)
    scheduleSupervisorSweep();
    // ADP-593 — exit de pop-out penceresine ulaşır (dışarıdaki ajan bitişini görür).
    // ADP-905 — hedef GÜNCEL pencereden çözülür (bkz. onData).
    sendPaneEvent(paneOwnerWindow(ptys.get(paneId), win), paneId, 'pty:exit', {
      paneId,
      agentId,
      code: exitCode,
      // WIN-FIRSTRUN-01 (K2) — renderer bu bayrakla hücreyi kapatmaz. Eski renderer
      // alanı bilmez → bugünkü davranış (kapatır); alan eklemek geriye uyumludur.
      earlyExit: early.early === true,
      msSinceSpawn: early.msSinceSpawn,
      firstDataBytes: early.firstDataBytes,
    });
    // ADP-192 — a pane that EXITS on its own (agent finished, or the user closed
    // it) must NOT be restored next launch. But a pane killed because the app is
    // TEARING DOWN carries entry.preserve (set by killAllPtys / killPtysForWindow)
    // — keep its registry entry so restart-resume can re-spawn it.
    const entry = ptys.get(paneId);
    if (entry && !entry.preserve) {
      try { livePaneRegistry.removePane(paneId, crewpaneHome()); } catch { /* best-effort */ }
    }
    // ADP-324 — VT ekranını serbest bırak (pane başına ~200-400 KB; sızdırmayalım).
    if (entry && entry.screen) { try { entry.screen.dispose(); } catch { /* best-effort */ } }
    sessionAnchor.forget(paneId); // ADP-705 — ölen pane'in bekleyen oturum-çapası düşer
    // INT-0-C — ölen pane'in ENTEGRASYON MCP config'i de düşer. Config artık pane
    // başına (`mcp/integrations-<paneKey>.json`) olduğu için bu silme YIKICI DEĞİL:
    // yalnız bu pane'in dosyasına dokunur, komşunun canlı config'ine ASLA. (Eskiden
    // dosya PAYLAŞIMLIYDI ve bir spawn hepsini siliyordu — kartın kökü buydu.)
    try {
      agentRunner.cleanupIntegrationsMcpConfig(
        crewpaneHome(),
        (entry && entry.integrationsKeyOpts) || { agentId, paneId },
      );
    } catch { /* best-effort */ }
    // AGY-01 — ölen pane'in ÇALIŞMA-ALANI PLUGIN kökü de düşer (antigravity).
    // Aynı gerekçe: kök pane BAŞINA (`engine-plugins/<paneKey>`) olduğu için silme
    // yalnız bu pane'e dokunur, komşunun canlı demetine ASLA. Demet bir sonraki
    // spawn'da zaten idempotent olarak yeniden üretilir.
    try {
      agentRunner.cleanupAgyWorkspacePlugin(
        crewpaneHome(),
        (entry && entry.integrationsKeyOpts) || { agentId, paneId },
      );
    } catch { /* best-effort */ }
    // TOK-B — ölen pane'in dağıtım hafızası da düşer: id yeniden kullanılırsa
    // BAŞKA bir konuşmanın metnine göre "ilişkisiz" hükmü verilirdi.
    dispatchStore.clear(paneId);
    dispatchApplied.delete(paneId);
    leaderRefreshState.delete(paneId); // LDR-F1 — pane öldü: backoff/deneme defteri de gider
    ptys.delete(paneId);
    // RESTORE-DEADSESSION-FALLBACK — bir RESUME spawn'ı "No conversation found"
    // basıp genç öldüyse (session dosyası silinmiş/taşınmış — e2e M1 mekanizması
    // gerçek kullanıcıda da olur) aynı kimlikle FRESH spawn'a düş. Fresh spawn
    // resume:false taşıdığından resumeOpts almaz → zincirleme respawn imkânsız.
    if (
      entry &&
      entry.resumeOpts &&
      !entry.preserve &&
      agentRunner.isDeadSessionExit({
        buffer: entry.buffer,
        exitCode,
        uptimeMs: Date.now() - entry.startedAt,
      })
    ) {
      logLine(
        `restore: dead session detected paneId=${paneId} agent=${entry.agentId ?? '-'} ` +
          `(session=${entry.sessionId ?? '-'}) → fresh spawn fallback`,
      );
      try {
        // ADP-905 — taze fallback de GÜNCEL pencereye doğar (eski pencere kapanmış olabilir).
        // PLAN-FIX-01 (F-4) — 'replace': ÇIKMAKTA olan pane'in yerine doğuyor, net artış
        // yok. `spawnIntent` spread'den SONRA yazılır: `resumeOpts` bir restore
        // spawn'ından kopyalanmış olabilir ve o niyeti buraya taşıması YANLIŞ olurdu.
        const res = spawnPty(paneOwnerWindow(null, win), {
          ...entry.resumeOpts,
          resume: false,
          sessionId: undefined,
          spawnIntent: 'replace',
        });
        logLine(`restore: fresh fallback spawned paneId=${res.paneId} agent=${entry.agentId ?? '-'}`);
      } catch (e) {
        logLine(`restore: fresh fallback failed agent=${entry.agentId ?? '-'}: ${e.message}`);
      }
    }
  });

  // B-02 (§3) — YENİ PANE = YENİ AĞAÇ İHTİMALİ. İzole ağaç bu spawn'dan
  // saniyeler önce `worktree add` ile doğmuş olabilir; o yol için elde kalmış
  // bayat (ya da "git değil" diyen) bir cache girdisi rozeti ilk 5 saniye BOŞ
  // bırakırdı — tam da kullanıcının pane'e ilk baktığı an.
  invalidateGitBranchCache(plan.cwd);

  ptys.set(paneId, {
    child,
    win,
    agentId,
    // INT-0-C — pane KAPANIRKEN kendi entegrasyon config'ini silebilmek için, SPAWN
    // ANINDA kullanılan dosya anahtarının GİRDİLERİ saklanır. Kapanışta `{agentId,
    // paneId}` ile yeniden türetmek YETMEZ: `agentId` taşımayan bir lider spawn'ı
    // anahtarı `leaderId`den alır ve tahmin yanlış dosyayı hedeflerdi (sahipsiz
    // artık). Anahtar İDDİA değil, ÖLÇÜM olsun diye buradan taşınır.
    integrationsKeyOpts: {
      agentId: opts.agentId ?? null,
      paneId: opts.paneId ?? null,
      leaderId: opts.leaderId ?? null,
    },
    department,
    command: plan.key,
    label,
    cwd: plan.cwd,
    pid: child.pid,
    // B-01 — pane ↔ görev ↔ izole ağaç bağı, CANLI tarafta. Üçü de `plan`den gelir,
    // yani İDDİA değil ÖLÇÜM (kademe-0 uygulanmadıysa null). Tüketiciler: kanıt yolu
    // çözümü (F-7), `worktree:*` IPC'leri, sahiplik kapısının canlılık sorgusu.
    taskId: plan.taskId ?? null,
    branch: plan.taskBranch ?? null,
    worktreePath: plan.taskWorktree ?? null,
    // BR-01 (ADR-INT-BRIDGE §2.3) — bu pane'e spawn ANINDA yazılan entegrasyonlar +
    // hangi bağlamda çözümlendikleri. Keşif ucu `toolsLiveInThisPane`i buradan
    // cevaplar: "vault'ta kayıt var" ile "bu pane'in claude'u o server'ı okudu"
    // farklı iki gerçektir (pane açıkken bağlanan servisin aracı BU pane'de yoktur).
    integrations: plan.integrations ?? null,
    // TOKEN-BUDGET-01 — bu pane'in SABİT YÜK künyesi (kimlik uzunluğu + bağlam
    // kapsamı kararı). `pty:tokenUsage` yanıtına konur; kart "bu pane'in sabit yükü
    // ~N jeton/istek" satırını buradan çizer. Motor koşmayan pane'lerde null kalır.
    fixedLoad: plan.fixedLoad ?? null,
    // ENG-OPENCODE-DB-01 (C4) — bu pane'in ÜRÜN-ÜRETİMİ yerel depo dosyası (null =
    // izolasyon beyan etmeyen motor / kullanıcı kendi deposunu ezmiş). İkiz kapısının
    // canlı listesi (`liveIsolationFiles`) buradan beslenir; İDDİA değil ÖLÇÜM
    // (buildSpawn env'den okudu).
    isolationFile: plan.isolation ? plan.isolation.file : null,
    mcpConfigCount: Array.isArray(plan.argv) ? plan.argv.filter((a) => a === '--mcp-config').length : 0,
    // ADP-087 — minted claude session id (null for codex/shell). Available for the
    // resume-queue capture (ADP-088); not used to trigger anything in this phase.
    // ADP-694 — rehber pane'inde motor HİÇ koşmadı → o session id'ye ait bir defter
    // ASLA oluşmaz. null bırakılır ki transcript okuyucuları ve restart-resume onu
    // "var olmayan oturumu devam ettir" diye kovalamasın.
    // ADP-852 — çalışma alanı rehber pane'inde de motor koşmadı → aynı kural.
    // ENG-OPENCODE-PROVIDER-01 — model kapısı rehber pane'inde de motor koşmadı → aynı kural.
    sessionId: engineMissing || workspaceMissing || vendorGate.blocked || modelGate.blocked || shellMissing ? null : plan.sessionId ?? null,
    // LDR-F1 — HAM ROL SLUG'I CANLI DEFTERDE. `livePaneRegistry` bunu zaten yazıyordu
    // (restart yolu için) ama CANLI defterde yoktu → main "bu pane bir LİDER mi" sorusunu
    // ancak renderer'a sorarak cevaplayabilirdi. Lider tazeleme tetiği main'de koştuğu
    // için hüküm de main'de olmalı: renderer'ın gönderdiği bir bayrağa güvenmek, o kararı
    // ölçümden KOPUK bir emre çevirirdi (`pty:dispatchRefresh`in aynı gerekçesi).
    // null = rol bildirilmemiş (kabuk/rehber pane'i) → lider SAYILMAZ (tahmin yok).
    role: typeof opts.role === 'string' && opts.role.trim() ? opts.role.trim() : null,
    // TASK-MQSBV4EFQ8D6B — mark delegation EXECUTION panes (ADP-136 --disallowedTools Task)
    // so the free-pane recycler frees ONLY worker panes for an agent and NEVER the leader's
    // pane (the leader is spawned without this flag).
    disallowSubagent: opts.disallowSubagent === true,
    // ADP-526 — pane model chip'i: K1 spawn-anı etiketi (null = bilinmiyor → chip yok)
    // + pane-başına K2 sniffer'ı (agent-dışı engine'de push'ları no-op).
    modelLabel,
    modelSniffer: plan.isAgent ? modelDetect.createModelSniffer(plan.key) : null,
    // ADP-565 — the EFFECTIVE launch model id (`--model <val>`; null = engine default).
    // The AUTHORITATIVE source for "which model is this agent on" (list() returns it);
    // the delegation reuse-mismatch gate compares a subtask's requested model against it.
    // Updated in place when a claude pane's model is switched in-session (/model, below).
    launchModel,
    // AGENT-MODEL-01 — bu pane'in EFEKTİF launch eforu (null = bayrak eklenmedi).
    // launchModel'in kardeşi: rozet ve `pty:list` bunu okur. Oturum-içi DEĞİŞMEZ —
    // `--effort` bir launch bayrağıdır, claude'un `/model`i gibi bir muadili yoktur.
    launchEffort,
    // ADP-595 — the EFFECTIVE codex custom provider this pane was LAUNCHED with
    // (buildSpawn.plan.provider; null = the engine's own default provider). Authoritative
    // like launchModel: the delegation reuse gate compares a subtask's requested provider
    // against THIS (codex cannot switch provider in-session → mismatch means respawn).
    launchProvider: plan.provider ?? null,
    // ACCT-FIX-01 — bu pane HANGİ hesap profiliyle koşuyor (buildSpawn'ın çözdüğü,
    // env'e yazdığıyla AYNI kimlik; null = motor değil/çözülemedi). Tüketiciler:
    // limit defteri (pane'in hesabı limitli yazılır, defterdeki aktif değil — §5.4)
    // ve "Bu hesaba geç" listesi ("şu pane'ler hâlâ eski hesapla çalışıyor").
    engineProfileId: plan.engineProfileId ?? null,
    // ENG-07 (ENG-R3 §2.3) — BU PANE'İN YAPAMAYACAKLARI. buildSpawn'ın argv hunisi bir
    // yeteneği descriptor'da `null` bulup atladığında kayıp artık SESSİZ değildir:
    // liste burada pane'in kaydında yaşar (ENG-10 rozetlerinin okuyacağı veri) ve
    // aşağıda log'a düşer. `null` = motor olmayan pane (kabuk) — uydurma beyan yok.
    capabilities: paneCapabilities,
    // ADP-694 — bu pane bir MOTOR-EKSİK REHBER pane'idir (motor CLI bulunamadı, gerçek
    // motor HİÇ başlatılmadı). Renderer kaplamayı bundan çizer; `pty:list` de taşır ki
    // yeniden yüklenen bir renderer rehberi kaybetmesin. null = normal ajan/kabuk pane'i.
    engineMissing,
    engineInstallGuide: installGuide,
    // ADP-852 — bu pane bir ÇALIŞMA-ALANI-EKSİK rehber pane'idir. `engineMissing` ile
    // aynı yaşam döngüsü: attach/list de taşır ki reload sonrası kaplama kaybolmasın.
    workspaceMissing,
    // RESTORE-DEADSESSION-FALLBACK — bu pane bir RESUME denemesiyse spawn şekli saklanır:
    // "No conversation found"+genç exit'te aynı kimlikle FRESH spawn'a düşülür (onExit).
    // Fresh/normal spawn'larda null → fallback yolu hiç açılmaz.
    resumeOpts: opts.resume === true ? { ...opts } : null,
    startedAt: Date.now(),
    lastDataAt: 0,
    // WIN-FIRSTRUN-01 — K3: ilk chunk damgası + o ana kadar bekletilen resize (win32).
    firstDataAt: 0,
    pendingResize: null,
    // WIN-FIRSTRUN-01 — K1: bu pane bir KABUK-EKSİK rehber pane'idir (motor başlatılmadı).
    // attach/reload'da kaplama buradan yeniden kurulur (engineMissing ile aynı gerekçe).
    shellMissing,
    // ENG-OPENCODE-PROVIDER-01 — bu pane bir MODEL-KAPISI rehber pane'idir (motor
    // başlatılmadı). Sebep + model + (varsa) adres; sır/anahtar ASLA (kapı onları okumaz).
    modelGate: modelGate.blocked
      ? { reason: modelGate.reason, model: modelGate.model, url: modelGate.url ?? null, engine: plan.key }
      : null,
    // ADP-266 — soft-reset bookkeeping: how many delegations this warm session has served
    // (MAX_TASKS_PER_SESSION backstop) and when it was last cleared (dispatch grace).
    taskCount: 0,
    lastResetAt: 0,
    // ADP-028 — replay buffer + cumulative byte counter (see PANE_BUFFER_MAX).
    // ADP-386 — RESUME spawn'ında buffer boş başlamaz: önceki oturumun ekran kuyruğu
    // (registry screenTail) + durum satırıyla tohumlanır. Kanıtlanan bug: restore
    // sonrası attach `bufLen=0` dönüyor, `claude --resume` büyük oturumu okurken
    // SANİYELERCE sessiz → pane o pencerede SİMSİYAH (yeşil "working" noktasıyla).
    // Tohum yalnız görüntü kanalıdır: `bytes` 0 kalır (canlı event seq'leri > 0
    // olduğundan attach dedupe bozulmaz), engine alt ekrana geçince TUI devralır,
    // mobil VT defteri (paneScreen) etkilenmez.
    buffer: (opts.resume === true ? restoreSeedText(opts) : '') + isolationNotice,
    bytes: 0,
    // ADP-324 — mobil okuma kanalının VT ekranı: ham pty akışı gerçek terminal emülatöründen
    // (renderer'la AYNI xterm 6.0.0) geçirilir, çıktı seq'li SATIRLARA dönüşür. Masaüstü
    // terminali ve lider (cleanPaneTail) bundan ETKİLENMEZ — yalnız mobil bunu okur.
    screen: paneScreen.createPaneScreen({
      // ADP-335 — bu pane'in VT defteri kendi hata sınırında koşar: harvest patlarsa (Eren'in
      // ReferenceError vakası) YALNIZ bu pane degrade olur; pty, masaüstü terminali, gateway
      // ve diğer pane'ler çalışmaya devam eder. Hata bildirim merkezine + log'a düşer.
      paneId,
      // ADP-362 — VT, PTY'NİN BOYUTUYLA doğar (eskiden sabit 100×30'du). Ajan CLI'ı TUI'sini
      // pty'nin cols'una çizer; VT dar kalırsa satırları sarar ve mobil defterde satır
      // BÖLÜNÜRDÜ (ölçüldü). 'pty:resize' geldiğinde de izlenir (aşağıda).
      cols,
      rows,
      onFault: reportModuleFault,
      log: logLine,
      // SSE artık CHUNK değil, KESİNLEŞMİŞ SATIR yayınlar (chunk sınırı satır sınırı değildi).
      // Olay adı `pane-line` (seq'li) — mobil istemcinin sözleşmesi (mobile/src/api/client.ts).
      // DİKKAT: eski `pane` olayı ARTIK YAYINLANMIYOR; istemci iki tipi de dinlediği için ikisini
      // birden basmak her satırı İKİ KEZ eklerdi.
      // PERF-BG-01 — CANLI satır hesabı yalnız İZLEYEN varken yapılsın (bkz.
      // paneScreen.cjs#wantsLive). Kesinleşen satır defteri bundan ETKİLENMEZ;
      // mobil sonradan bağlandığında `tail()` geçmişi eksiksiz döndürür.
      wantsLive: () => mobileSubscribers.size > 0,
      onLine: (entry) => {
        if (mobileSubscribers.size === 0) return;
        emitMobileEvent({ type: 'pane-line', paneId, agentId, seq: entry.seq, text: entry.text, at: Date.now() });
      },
      // İlerleme satırı (TUI yerinde yeniden çiziyor): seq YOK, ayrı tip — satır defterine
      // GİRMEZ. Kısılmıştır (spinner saniyede onlarca kez değişebilir).
      onLive: (text) => {
        if (mobileSubscribers.size === 0) return;
        const now = Date.now();
        const e = ptys.get(paneId);
        if (e) {
          if (now - (e.lastLiveAt || 0) < PANE_LIVE_THROTTLE_MS) return;
          e.lastLiveAt = now;
        }
        emitMobileEvent({ type: 'pane-live', paneId, agentId, text, at: now });
      },
    }),
    lastLiveAt: 0,
  });
  // ADP-192 — persist the spawn shape of every live AGENT pane so a restart can
  // re-launch it on its prior claude session (`--resume <sessionId>`). Only agent
  // panes (a bare shell has no conversation); recorded with the SAME sessionId so
  // a subsequent restart resumes again (self-healing). Best-effort — a failed
  // write just means that one pane won't auto-restore (no crash).
  if (plan.isAgent && !RESTORE_DISABLED) {
    try {
      livePaneRegistry.recordPane(
        paneId,
        {
          agentId,
          department,
          // PANE-RESTORE-DUP-01 — restore'dan geldiyse ESKİ anahtar taşınır (aynı satır
          // güncellenir); taze spawn'da null → defter kendi anahtarını basar.
          restoreKey: typeof opts.restoreKey === 'string' && opts.restoreKey ? opts.restoreKey : null,
          cwd: plan.cwd,
          engine: plan.key,
          // ADP-694 — rehber pane'inde oturum yok (bkz. yukarıdaki not): restart bunu
          // `--resume <yok-olan-id>` ile açmaya çalışmasın, TAZE spawn'a düşsün.
          sessionId: engineMissing || workspaceMissing ? null : plan.sessionId,
          // ADP-565 — persist the launch model so a restart re-launches the pane on
          // the SAME model (the resume spawn passes it back into opts.model → --model).
          model: plan.model ?? null,
          // ADP-595 — same for the codex custom PROVIDER: `-c model_provider=…` is a
          // per-launch flag (not conversation state), so a resumed pane must re-select it
          // or it silently falls back to the engine default provider.
          provider: plan.provider ?? null,
          label,
          role: opts.role ?? null,
          plain: opts.plain === true,
          browserCapable: opts.browserCapable === true,
          disallowSubagent: opts.disallowSubagent === true,
          systemPrompt: typeof opts.systemPrompt === 'string' ? opts.systemPrompt : null,
          // B-01 (H-2) — GÖREV ↔ BRANCH ↔ İZOLE AĞAÇ. `plan.taskWorktree` bir İDDİA
          // değil ÖLÇÜMDÜR: buildSpawn onu yalnız kademe-0 GERÇEKTEN uygulandıysa
          // döndürür (yol yoksa null). Restart bu satırı okuyup aynı worktree'ye
          // döner; pane başlığındaki branch rozeti de artık cwd'nin HEAD'ini tahmin
          // etmek yerine bu kaydı okur (§2.10).
          taskId: plan.taskId ?? null,
          branch: plan.taskBranch ?? null,
          worktreePath: plan.taskWorktree ?? null,
          // ENG-07 — motorun BEYAN EDİLMİŞ eksikleri kayda da girer: restart sonrası
          // rozet (ENG-10) pane'i yeniden ölçmek zorunda kalmaz, kayıttan okur.
          capabilities: paneCapabilities,
        },
        crewpaneHome(),
      );
    } catch (e) {
      logLine(`live-pane record failed paneId=${paneId}: ${e.message}`);
    }
  }
  // `shell` kept for ADP-003 callers; `command`/`agentId` are the ADP-013 fields.
  // ADP-502 — `cwd`: the REAL spawn cwd (department-resolved). The renderer's
  // delegation engine anchors its evidence probes on it; before this it assumed
  // `worker.cwd` (always undefined) and only worked by coincidence.
  // ADP-694 — `engineMissing` + `engineInstall`: motor CLI yoksa bu pane bir KURULUM
  // REHBERİDİR. Renderer bunu spawn cevabından öğrenir ve kaplamayı (komut + kopyala +
  // tekrar dene) çizer; eski main build'lerinde alan yoktur → alan yoksa bugünkü davranış.
  return {
    paneId,
    pid: child.pid,
    command: plan.key,
    shell: spawnFile,
    agentId,
    department,
    cwd: plan.cwd,
    model: launchModel,
    engineMissing,
    engineInstall: installGuide,
    // ADP-852 — çalışma alanı seçilmemiş: pane bir REHBERDİR, ajan başlatılmadı.
    // `defaultWorkspaceDir` kaplamanın "önerilen klasörü oluştur" satırında gösterilir
    // (yol RENDERER'DAN GELMEZ — ADP-103 capability-by-user-choice; renderer yalnız çizer).
    workspaceMissing,
    defaultWorkspaceDir: workspaceMissing ? workspaceOnboarding.defaultWorkspaceDir() : null,
    // WIN-FIRSTRUN-01 (K1) — Windows kabuk ön koşulu tutmadı: pane bir REHBERDİR.
    // Renderer kaplamayı (link + "Tekrar dene") buradan çizer; eski main'de alan yok.
    shellMissing,
    // ENG-OPENCODE-PROVIDER-01 — model kapısı kapalı: pane bir REHBERDİR (null = normal).
    modelGate: modelGate.blocked ? { reason: modelGate.reason, model: modelGate.model, url: modelGate.url ?? null } : null,
  };
}

/**
 * Pane etiketinden görev kodu — İKİ pane listesinin (renderer `listPanes` ve lider
 * `allPanesForControl`) ORTAK tek çıkarımı. STAT-D2 §B-1: iki liste ayrı ayrı
 * hesaplayınca biri hesaplamayı unuttu ve lider yolu daima `null` gördü; kod tek
 * yerde durursa "unutmak" yapısal olarak imkânsızlaşır. Çıkarımın kaynağı yine
 * `taskCode.cjs` (B-01 Faz A) — burada regex YAZILMAZ, ÇAĞRILIR.
 */
function labelTaskCodeOf(label) {
  try { return taskCodeMod.taskCodeOf(label) || null; } catch { return null; }
}

/**
 * Snapshot live panes for one window (ADP-013 `list`). Optionally filtered by
 * department so ADP-012 can render exactly the active team's pane-set. Returns
 * only serialisable binding fields (never the child handle).
 */
function listPanes(win, department) {
  const now = Date.now();
  const out = [];
  for (const [paneId, e] of ptys) {
    if (win && e.win.id !== win.id) continue;
    if (department && e.department !== department) continue;
    out.push({
      paneId,
      agentId: e.agentId ?? null,
      department: e.department ?? null,
      command: e.command,
      label: e.label ?? null,
      pid: e.pid,
      startedAt: e.startedAt,
      status: agentRunner.statusFor(e.lastDataAt, now),
      // ADP-108 — the pane's spawn cwd. Live-watch needs it to rebase a RELATIVE
      // path the agent prints ("oyun/x.html") to the ABSOLUTE file it actually
      // wrote (under this cwd, which defaults to HOME — NOT the editor's workspace
      // root). Without it the editor looked for the file under crewpane/ and never
      // opened it (the false-PASS root cause).
      cwd: e.cwd ?? null,
      // ADP-526 — pane'de koşan AI modelinin insan-okur etiketi (header chip'i).
      // null → bilinmiyor, chip hiç çizilmez ("?" basılmaz).
      modelLabel: e.modelLabel ?? null,
      // ADP-565 — the pane's EFFECTIVE launch model id (`--model`; null = engine
      // default). Authoritative — the delegation reuse gate compares the requested
      // model against THIS to decide claude in-session /model vs codex respawn.
      launchModel: e.launchModel ?? null,
      // AGENT-MODEL-01 — pane'in EFEKTİF launch eforu (null = bayrak eklenmedi →
      // motorun kendi varsayılanı). Renderer rozeti/kartı bunu okur.
      launchEffort: e.launchEffort ?? null,
      // ADP-595 — the pane's EFFECTIVE codex provider (`-c model_provider=…`; null =
      // engine default). The reuse gate drops a candidate whose provider differs (codex
      // has no in-session provider switch). Absent from older main builds.
      launchProvider: e.launchProvider ?? null,
      // ACCT-FIX-01 — pane'in hesap profili KİMLİĞİ (dizin/jeton değil). Eski main
      // build'lerinde yok → renderer `undefined`i "bilinmiyor" okur.
      engineProfileId: e.engineProfileId ?? null,
      // ADP-558 — the INVISIBLE half-work flag (the user-facing "yarım iş"
      // label/badge was removed; the ADP-288/289 hygiene machinery now rides on
      // this flag alone). Set via pty:bind at stall time, cleared on idle relabel.
      stalled: e.stalled === true,
      // ADP-502 — the stalled pane's evidence target (set via pty:bind at stall
      // time, cleared on idle relabel). Lets a freshly reloaded renderer rebuild
      // its stall ledger so an orphaned stall can still be retracted.
      stallEvidence: e.stallEvidence ?? null,
      // ADP-667 — GECİKMELİ RESET bayrağı: iş bitince `/clear` YAZILMAZ (worker'ın son
      // çıktısı ekranda kalsın), bu pane sıradaki dispatch'ten hemen önce temizlenir.
      // Bayrak main'de yaşadığı için renderer-only reload onu kaybetmez.
      pendingReset: e.pendingReset === true,
      // ADP-532 — pty'nin gerçek boyutu: renderer xterm'iyle karşılaştırılıp
      // drift'te refit tetiklenir (pane altında boş alan / bayat TUI çizimi).
      cols: typeof e.child?.cols === 'number' ? e.child.cols : null,
      rows: typeof e.child?.rows === 'number' ? e.child.rows : null,
      // ADP-694 — motor CLI bulunamadığı için açılmış KURULUM REHBERİ pane'i mi?
      // (null = normal pane). Yeniden yüklenen bir renderer rehberi bundan geri kurar.
      engineMissing: e.engineMissing ?? null,
      engineInstall: e.engineInstallGuide ?? null,
      // ADP-852 — çalışma alanı seçilmemiş olduğu için açılmış REHBER pane'i mi?
      workspaceMissing: e.workspaceMissing === true,
      // WIN-FIRSTRUN-01 (K1) — Windows kabuk rehberi pane'i mi? (null = normal pane)
      shellMissing: e.shellMissing ?? null,
      // ENG-OPENCODE-PROVIDER-01 — model kapısı rehber pane'i mi? (null = normal pane)
      modelGate: e.modelGate ?? null,
      // ── B-02 — PANE'İN KENDİ GÖREV BAĞI (§2.10) ──────────────────────────
      // Terminal başlığındaki görev rozeti bugüne kadar AJANA atanmış board
      // görevini gösteriyordu (`taskByAgent`); aynı ajan ikinci bir görev pane'i
      // açtığında İKİ BARDA AYNI (ve birinde yanlış) numara çıkıyordu. Rozetin
      // doğru kaynağı pane'in KENDİ bağıdır ve o bağ burada, main'de yaşar:
      //   • `taskId` — B-01 Faz B, spawn anında ÖLÇÜLDÜ (izolasyon açıkken dolu);
      //   • `labelTaskCode` — pane etiketinden çıkarılan kod. Çıkarımın TEK kaynağı
      //     `taskCode.cjs` (B-01 Faz A); renderer regex YAZMAZ, burada çözülüp
      //     taşınır — yoksa "görev kodu" tanımı iki süreçte ayrışırdı (F-6 dersi).
      taskId: e.taskId ?? null,
      labelTaskCode: labelTaskCodeOf(e.label),
      // B-01 — pane defterindeki dal + izole ağaç. Bu BEKLENEN daldır; ağacın
      // GERÇEĞİ `git:branch(cwd)`ten gelir ve ikisi çelişirse renderer ⚠ çizer.
      branch: e.branch ?? null,
      worktreePath: e.worktreePath ?? null,
      // ENG-10 — BU PANE'İN YETENEK BEYANI (ENG-07 verisi + kullanıcı-yüzü matris).
      // Ofis hover kartı, terminal başlığı, ayarlar motor kartı ve entegrasyon hub'ı
      // rozetlerini BUNDAN çizer; renderer motor adına göre HİÇBİR hüküm kurmaz.
      // null = kabuk pane'i / eski main build'i → rozet çizilmez (uydurma beyan yok).
      capabilities: e.capabilities ?? null,
    });
  }
  return out;
}

/** Kill every pty owned by the given window. ADP-192 — this is a TEARDOWN (window
 * closed / app quitting), NOT an intentional per-agent close, so mark each entry
 * `preserve` first: onExit then KEEPS its live-pane registry entry → the agent is
 * restored on the next launch (restart-resume). */
/**
 * PANE-CAP-01 — AÇIK KAPATMA yolu, TEK yerde. Daha önce bu gövde yalnız `pty:kill`
 * IPC'sinin içinde yaşıyordu; kaynak bekçisinin "bitmiş pane'leri kapat" onayı da
 * aynı işi yapmak zorunda (registry + görünüm + taslak + ödenek temizliği). İkinci
 * bir kapatma yolu yazmak, quit-yarışı düzeltmesini (TASK-MRDXOGZJDQLJG) yalnız
 * yollardan BİRİNDE bırakırdı.
 * @returns {boolean} pane gerçekten kapatıldı mı
 */
/**
 * MCP-COST-01 — PANE KAPANDI, MCP COCUKLARI DA KAPANSIN.
 *
 * Normal kapanista motor (claude) kendi MCP cocuklarini indirir ve olcum bunu
 * dogruluyor (09.09: 14 pane, 0 yetim). Bu yol o yolun KOSMADIGI hal icindir —
 * SIGKILL, cokme, quit yarisi. Iki kapili: (1) kapanis aninda BU motorun MCP
 * cocuklari DEFTERLENIR, (2) bekleme suresi sonunda yalniz DEFTERDE OLAN ve
 * HALA YETIM olan sureclere dokunulur. Atif tahminle degil FARKLA
 * (ORPHAN-ELECTRON-01 / TREE-ORPHAN-01 deseni): araya giren yeni bir pane'in
 * MCP'si defterde olmadigi icin asla biçilemez.
 *
 * Olcemezsek / hicbir cocuk yoksa: tam no-op.
 */
const MCP_REAP_GRACE_MS = 10_000;
function scheduleMcpChildReap(enginePid, paneId) {
  if (!Number.isInteger(enginePid) || enginePid <= 1) return;
  let ledger = [];
  try {
    ledger = mcpProcess.listMcpProcesses().rows
      .filter((r) => r.ownerPid === enginePid)
      .map((r) => r.pid);
  } catch { return; }              // olcemedik → HICBIR SEY iddia etmiyoruz
  if (!ledger.length) return;
  const timer = setTimeout(async () => {
    try {
      // `pids` verildigi icin yas kapisi uygulanmaz (selectReapable sozlesmesi);
      // `listOrphanMcp` yine de YETIM olmayanlari eler → canli bir pane'in
      // MCP'si defterde olsa bile dokunulmaz.
      const res = await mcpProcess.reapOrphanMcp({ pids: ledger, minAgeMs: 0 });
      if (res.reaped.length) {
        logLine(`mcp-reap paneId=${paneId} engine=${enginePid} reaped=${res.reaped.length}/${ledger.length} pids=${res.reaped.map((r) => r.pid).join(',')}`);
      }
    } catch (e) {
      logLine(`mcp-reap failed paneId=${paneId}: ${(e && e.message) || e}`);
    }
  }, MCP_REAP_GRACE_MS);
  if (typeof timer.unref === 'function') timer.unref(); // quit'i BEKLETMEZ
}

function killPaneExplicitAndCleanup(paneId) {
  // Motor pid'i OLMEDEN once okunmali: kill sonrasi entry dusuyor.
  const enginePid = (() => {
    try { return ptys.get(paneId)?.child?.pid ?? null; } catch { return null; }
  })();
  const res = paneKill.killPaneExplicit({
    paneId,
    entry: ptys.get(paneId),
    isQuitting: app.isQuitting === true,
    registry: livePaneRegistry,
    homedir: crewpaneHome(),
    resumeDaemon: ptyResumeDaemon,
    log: logLine,
  });
  if (res.killed) {
    ptys.delete(paneId);
    // MCP-COST-01 — motorun MCP cocuklari da kapansin (grace sonunda, yalniz yetimler).
    scheduleMcpChildReap(enginePid, paneId);
    // ADP-712 — pane öldü: görünüm tercihini de düşür (hayalet kayıt bırakma).
    paneViewState.clearPaneView(paneId);
    // ADP-786 — gönderilmemiş taslak da düşer: sahibi kalmamış metin birikmesin.
    paneDraft.clearPaneDraft(paneId);
    // TOK-C — "devam et" ödeneği de düşer: ödenek O PANE'in O OTURUMUNA verilmiş
    // bir izindir; aynı paneId yeniden kullanılırsa dünkü izni miras almamalı.
    paneBudgetStore.clearPane(paneId);
  }
  return res.killed === true;
}

function killPtysForWindow(winId) {
  // ADP-386 — ölmeden önce ekran kuyruğunu sakla (restore tohumlar; bkz. killAllPtys).
  const tails = {};
  for (const [paneId, entry] of ptys) {
    if (entry.win.id !== winId) continue;
    const tail = captureScreenTail(entry);
    if (tail) tails[paneId] = tail;
  }
  try { livePaneRegistry.setScreenTails(tails, crewpaneHome()); } catch { /* best-effort */ }
  for (const [paneId, entry] of ptys) {
    if (entry.win.id === winId) {
      entry.preserve = true;
      try { entry.child.kill(); } catch { /* already dead */ }
      ptys.delete(paneId);
    }
  }
}

// ---------------------------------------------------------------------------
// ADP-905 (P0) — PENCERE KAPANMASI AJANI ÖLDÜRMEZ (macOS).
// ---------------------------------------------------------------------------
// ÖLÇÜLEN OLAY (2026-08-05 00:47): kırmızı × ile ana pencere kapatıldı → aynı
// saniyede 12 ajan `code=129` (SIGHUP) ile öldü, ofis boşaldı, uygulama SÜREÇ
// OLARAK YAŞAMAYA DEVAM ETTİ (ADP-334 bilinçli kararı: darwin'de quit atlanır).
// Yani zincir kendi kendisiyle çelişiyordu: uygulama yaşıyor ama çocukları
// ölüyordu.
//
// MİMARİ GERÇEK: pty'ler `main` sürecinin çocuğudur (`ptys` haritası main'de
// yaşar). Bir BrowserWindow yalnız onların ÇIKTISINI çizer — hiçbir pty'nin
// hayatı pencereye bağlı DEĞİLDİR. Emsal zaten ağaçta: pane pop-out penceresi
// kapanınca "burada pty'ye HİÇBİR ŞEY yapılmaz" (ADP-593). Çözüm bu yüzden
// "daha nazik öldürmek" değil, HİÇ öldürmemektir.
//
// Kapı DAR: yalnız macOS'ta ve yalnız uygulama GERÇEKTEN çıkmıyorken. Gerçek
// quit'te (`before-quit` → app.isQuitting) ve win32/linux'ta (pencere kapanması
// = uygulamanın sonu) eski davranış BİT BİT aynı kalır — orada pty'yi öldürmek
// doğrudur, çünkü süreç zaten ölecek ve `preserve` defteri restart-resume için
// korur.
function keepPanesAliveOnWindowClose() {
  return process.platform === 'darwin' && !app.isQuitting && !AUTOTEST;
}

/** ADP-905 — bu pane'in çıktısını ŞU AN hangi pencere çizmeli? Sahibi yaşıyorsa o;
 * pencere kapanıp yenisi açıldıysa (pty yaşamaya devam etti) güncel ana pencere.
 * Eskiden spawn anındaki `win` closure'ı kullanılıyordu: pencere yeniden açılınca
 * canlı ajanın baytları YOK EDİLMİŞ pencereye gönderiliyor (sendPaneEvent'in
 * isDestroyed guard'ı yutuyor) ve pane sessiz kalıyordu. */
function paneOwnerWindow(entry, fallbackWin) {
  if (entry && entry.win && !entry.win.isDestroyed()) return entry.win;
  if (appWindow && !appWindow.isDestroyed()) return appWindow;
  return fallbackWin && !fallbackWin.isDestroyed() ? fallbackWin : null;
}

/** ADP-905 — pencere geri geldi: sahibi YOK OLMUŞ pane'leri yeni pencereye bağla.
 * (`entry.win` odaklama/pop-out gibi yollarda da kullanılıyor; tek yerde düzeltilir.)
 * Kaç pane yeniden bağlandığını döner. */
function rebindOrphanPanes(win) {
  if (!win || win.isDestroyed()) return 0;
  let n = 0;
  for (const entry of ptys.values()) {
    if (entry.win && !entry.win.isDestroyed()) continue;
    entry.win = win;
    n += 1;
  }
  if (n) logLine(`ADP-905 rebind: ${n} yaşayan pane yeni pencereye bağlandı (win=${win.id})`);
  return n;
}

/** Kaç AJAN pane'i canlı (kabuk pane'leri sayılmaz — F3 görünürlük sayacı). */
function liveAgentPaneCount() {
  let n = 0;
  for (const entry of ptys.values()) if (entry.agentId) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// ADP-035 / WIN-IMG-01 — temp image store for multimodal prompts.
// ---------------------------------------------------------------------------
// Bounds (RCE/abuse guard, ADP-013 disiplini): image MIME only, capped size,
// sanitized name, fixed temp dir. The renderer never touches fs.
//
// 🔴 WIN-IMG-01 — TTL YARIŞI KALDIRILDI. Buradaki eski kod her dosyaya yazma
// anında `setTimeout(unlink, 5dk)` kuruyordu ve gerekçesi "agent reads it < this"
// idi. Bu varsayım YAVAŞ TURLARDA TUTMUYOR (müşteri kanıtı, Windows v0.2.31: 4
// görsel eklendi, ajan yolları aldı, dosyalar diskte YOKTU). Ömür artık
// OTURUMA bağlı: `tempImageStore` uygulamanın o çalışmasına ait bir klasöre yazar,
// kapanışta siler, açılışta yetimleri süpürür. Süre YOK ⇒ yarış YAPISAL kapalı.
const imageStore = tempImageStore.createTempImageStore({ log: (line) => logLine(line) });

/** Write a renderer-supplied image blob to the session image dir; return its path. */
function saveTempImage(payload) {
  return imageStore.save(payload);
}

// ---------------------------------------------------------------------------
// BOARD-IMG-2/3 — GÖREV KARTI EKLERİ (task_attachments) · TEK YUTAK
// ---------------------------------------------------------------------------
// `imageStore`un TAM TERSİ bir ömür sözleşmesi: o OTURUMLUK (ajana yol verip
// kaybolur), bu KALICI (karta iliştirilen kanıt yıllarca durur). İkisi ayrı
// raflardır — biri diğerinin yerine geçmez.
//
// Kök HESAP-KAPSAMLI: `instancePaths.crewpaneHome()` zaten `accounts/<key>`e
// çözer (ADP-703), yani hesap değişince ekler de değişir — ayrı bir kapsam
// mantığı YAZILMAZ.
//
// TEMBEL: depo kökü hesap bağlanmasından SONRA doğrudur (`bindAccountRoot`).
// Açılışta hevesle kurmak, anonim köke bağlı bir depo üretirdi.
let _attachmentStore = null;
let _attachmentStoreRoot = null;

/**
 * 160px mikro küçük-resim (JPEG q60) — ÖLÇÜLDÜ: ~5.9 KB base64 (tasarım §1.3).
 * `clipboardHistory.cjs:256`'daki kanıtlanmış `nativeImage.resize(...)` deseninin
 * aynısı; oradaki gerekçe de aynıydı: 4K bir çekimin data-URL'ini listeye/satıra
 * koymak megabaytlar demektir.
 */
function makeAttachmentThumb(buf) {
  const img = nativeImage.createFromBuffer(buf);
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  // Zaten küçükse büyütmeyiz (bulanıklaştırmanın anlamı yok).
  const target = size.width > 160 ? img.resize({ width: 160, quality: 'good' }) : img;
  return { dataUrl: `data:image/jpeg;base64,${target.toJPEG(60).toString('base64')}`, width: size.width, height: size.height };
}

/**
 * FDBK-01 — ölçülebilir genişlikte JPEG üretici (geri bildirim köprüsünün
 * `makeImage` bağımlılığı). `makeAttachmentThumb` 160px'e SABİTTİR; burada
 * genişlik/kalite parametreyle gelir çünkü aynı köprü hem 160px liste küçük
 * resmini hem ~1000px kayıt karesini üretir. Aynı `nativeImage.resize` deseni.
 */
function makeFeedbackImage(buf, opts = {}) {
  const img = nativeImage.createFromBuffer(buf);
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const width = Math.max(64, Math.min(2000, Number(opts.width) || 160));
  const quality = Math.max(30, Math.min(90, Number(opts.quality) || 60));
  const target = size.width > width ? img.resize({ width, quality: 'good' }) : img;
  return {
    dataUrl: `data:image/jpeg;base64,${target.toJPEG(quality).toString('base64')}`,
    width: size.width,
    height: size.height,
  };
}

/** FDBK-01 — AgentShot çekim klasörü. AgentShot ayrı bir üründür; kurulu
 *  değilse klasör yoktur ve köprü zarifçe `no-dir` döner (özellik kapanır,
 *  sürükle-bırak yolu çalışmaya devam eder). */
function agentShotDir() {
  try {
    return path.join(os.homedir(), '.agentshot', 'shots');
  } catch {
    return null;
  }
}

let _feedbackBridge = null;
function feedbackBridge() {
  if (!_feedbackBridge) {
    _feedbackBridge = feedbackBridgeMod.createFeedbackBridge({
      logPath: () => LOG_PATH,
      shotsDir: agentShotDir,
      makeImage: makeFeedbackImage,
    });
  }
  return _feedbackBridge;
}

/** Bağlı hesabın ek deposu (kök değişirse yeniden kurulur). */
function attachmentStore() {
  const root = instancePaths.crewpaneHome();
  if (_attachmentStore && _attachmentStoreRoot === root) return _attachmentStore;
  _attachmentStore = attachmentStoreMod.createAttachmentStore({
    root,
    deviceId: (boundAccount && boundAccount.deviceId) || null,
    makeThumb: makeAttachmentThumb,
    log: (line) => logLine(line),
  });
  _attachmentStoreRoot = root;
  return _attachmentStore;
}

/**
 * TEK YUTAK — renderer IPC'si de köprü rotası da (MCP) BURAYA düşer.
 * Dönen şey DB satırı DEĞİL, satırın ALANLARIDIR: INSERT'i çağıran kendi
 * kimliğiyle yapar (renderer supabase-js, MCP PostgREST). İkinci bir DB
 * istemcisi icat etmeyiz.
 */
function ingestTaskAttachment(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const store = attachmentStore();
  const out = p.path
    ? store.ingestFile({
      sourcePath: p.path, taskId: p.taskId, title: p.title, kind: p.kind, source: p.source, createdBy: p.createdBy,
    })
    : store.ingestBuffer({
      data: p.data, taskId: p.taskId, title: p.title, kind: p.kind, source: p.source, createdBy: p.createdBy,
    });
  if (!out.ok) logLine(`[attach] reddedildi (${out.reason}${out.detail ? `: ${out.detail}` : ''})`);
  return out;
}

// ---------------------------------------------------------------------------
// ADP-440 — Screenshots özelliği AgentShot'a TAŞINDI (ayrı ürün).
// ---------------------------------------------------------------------------
// ADP-099/113/114/143/204'ün app-içi yakalama yüzeyi (capture bridge, bölge
// overlay'i, tray, annotator, ⌘⇧2/⌘⇧0 kısayolları) kaldırıldı; motor kodu
// packages/shot-core'da YAŞAMAYA DEVAM EDER (AgentShot'un çekirdeği — ADR-024).
// ⌘⇧2 burada bilerek KAYITLI DEĞİL: kayıtlı olsaydı AgentShot kısayolu alamazdı.
// ~/.crewpane/shots SİLİNMEZ (kullanıcı verisi); migrasyon:
// agentshot/scripts/migrate-crewpane-shots.cjs (ADP-440). AgentShot'tan pane'e
// gönderim (shotBridgeSend / onShotSend, ADP-352) ve ajanların kanıt-screenshot
// yolları (browser CDP + e2e) bu kaldırımdan ETKİLENMEZ.
function notifyScreenshotsMovedOnce() {
  try {
    // ADP-703 — tek-seferlik MAKİNE bildirimi + eski shots dizini: cihaz kökünde (D).
    const marker = path.join(instancePaths.instanceHome(), 'screenshots-moved-notice.json');
    if (fs.existsSync(marker)) return;
    const legacyShots = path.join(instancePaths.instanceHome(), 'shots');
    const usedFeature = fs.existsSync(legacyShots)
      && fs.readdirSync(legacyShots).some((f) => f.toLowerCase().endsWith('.png'));
    if (usedFeature) {
      new Notification({
        title: appI18n.t('main.notify.screenshotsMoved.title'),
        body: appI18n.t('main.notify.screenshotsMoved.body'),
      }).show();
      logLine('screenshots-moved notice shown (one-time)');
    }
    fs.writeFileSync(marker, JSON.stringify({ notifiedAt: new Date().toISOString(), usedFeature }));
  } catch (e) { logLine(`screenshots-moved notice error: ${e.message}`); }
}

// ─── ADP-390 (ADR-027 / G9) — CrewPane hesabı + CrewPane seat ────────────────
// CrewPane ekosistemin son halkası: kendisi de CrewPane hesabına bağlanır.
// Giriş SİSTEM TARAYICISINDA (PKCE, RFC 8252 — gömülü webview YASAK), dönüş
// `crewpane://auth/callback`. Seat KAPISI yazıldı ama geliştirici kopyasında
// varsayılan KAPALI — orada giriş OPSİYONEL, hiçbir yetenek kapanmaz; Ayarlar
// yalnız hesabı ve lisans durumunu GÖSTERİR. Müşteri build'inde kapı ZORUNLU.
//
// Yol iki dünyada farklı (shot-core ile aynı desen): dev'de repo kökündeki
// packages/, paketli app'te asar içine kopyalanan ./packages/.
const CREWPANE_AUTH_DIR = fs.existsSync(path.join(__dirname, 'packages', 'crewpane-auth'))
  ? path.join(__dirname, 'packages', 'crewpane-auth')
  : path.join(__dirname, '..', 'packages', 'crewpane-auth');
const crewpaneAuth = require(path.join(CREWPANE_AUTH_DIR, 'index.cjs'));
const { crewpaneIdConfig, gateOverrides, devEscapeProbeEnv } = require('./src/config/crewpaneId.cjs');
// ADP-780-B — bu kopyanın URL şeması (prod: crewpane · dev: crewpane-dev ·
// test: crewpane-test). Aşağıdaki üç kontrol de bu TEK kaynaktan okur; şema adı
// main.js'e ikinci kez YAZILMAZ (yazılsaydı dev build kendi dinlemediği bir şemayı
// kontrol eder ve giriş sessizce kırılırdı).
const { appScheme, appSchemePrefix } = require('./src/core/appScheme.cjs');
const APP_URL_SCHEME = appScheme();
const APP_URL_PREFIX = appSchemePrefix();
// ADP-801 — bu süreç bir OTOMASYON oturumu mu (e2e / ajan koşumu)? Şema talebi ve
// OS-yönlendirmeli giriş dönüşü buna göre KAPANIR: test kopyası kullanıcının
// `crewpane-dev://auth/callback`'ini yutmamalı (gerekçe: automatedSession.cjs).
const { isAutomatedSession, automatedSessionReason } = require('./src/agents/automatedSession.cjs');
const IS_AUTOMATED_SESSION = isAutomatedSession(process.env);
const AUTOMATED_SESSION_REASON = automatedSessionReason(process.env);
// ADP-646 — "müşteri build'i mi" (env ile DEĞİŞTİRİLEMEZ) tek gerçek kaynağı.
const buildChannel = require('./src/config/buildChannel.cjs');
const vendorSurface = require('./src/core/vendorSurface.cjs'); // BR-04 — vendor/müşteri YÜZEY kararı (tek yer)
const { createSeatGate } = require('./src/security/seatGate.cjs');
// ADP-614 — katman kataloğu (hangi entitlement CrewPane açar + etiketler).
const planCatalog = require('./src/config/planCatalog.cjs');
// ADP-660 — katman LİMİTİ kararı (Basic ⇄ Pro/Ultra). Karar + kullanıcı metni orada;
// burada yalnız boğazlara bağlama var (seatGate/decideAccess ile aynı iş bölümü).
const planLimits = require('./src/config/planLimits.cjs');

let seatGate = null;

/** Ayarlar'a canlı durum push'u (yeniden açmaya gerek kalmasın — ADP-384 deseni). */
function pushAccountState(snapshot) {
  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.webContents.send('crewpane:state', snapshot);
  }
  // SEC-02 — CİHAZ REDDİ EKRANA DÜŞSÜN. Ret arka planda (jeton tazeleme /
  // kalp atışı) doğar; Ayarlar açık değilse kullanıcı hiçbir şey görmezdi ve
  // "lisansım neden yenilenmiyor" sorusunun cevabı hiçbir yerde olmazdı.
  // Nudge yolu YENİ DEĞİL: BL-03'ün `plan:limit` kanalı — cümle planLimits'te,
  // düğme hedefi veriden. Burada yalnız sunucunun VERİSİ o kanala bağlanır.
  try { pushDeviceDenial(snapshot); } catch (e) { logLine(`[device] nudge hatası: ${e.message}`); }
  // ADP-703 — giriş yapılan hesap değiştiyse yerel veri kökü de değişmeli.
  try { reconcileAccountBinding(snapshot); } catch (e) { logLine(`[account] reconcile hatası: ${e.message}`); }
}

/**
 * SEC-02 — sunucunun cihaz reddini `plan:limit` nudge'ına çevir.
 *
 * Karar SUNUCUNUNDUR (jetonu imzalamayan taraf); burada ikinci bir tavan
 * hesaplanmaz. `planLimits.decide` yalnız CÜMLEYİ ve düğmeleri üretir — bu
 * yüzden `current` olarak sunucunun bildirdiği sayı verilir, istemcinin tahmini
 * değil. Reddedilen kadran `snapshot.device.feature` ile gelir (isim kontrolü yok).
 */
let lastDeviceDenialKey = null;
function pushDeviceDenial(snapshot) {
  const dev = snapshot && snapshot.device;
  if (!dev || dev.denied !== true || !dev.feature) {
    lastDeviceDenialKey = null; // çözüldü → bir sonraki ret yeniden bildirilebilsin
    return;
  }
  // Aynı ret her durum push'unda tekrar basmasın (nudge fırtınası).
  const key = `${dev.feature}:${dev.active}/${dev.limit}`;
  if (key === lastDeviceDenialKey) return;
  lastDeviceDenialKey = key;
  const denial = planLimits.decide({
    snapshot,
    feature: dev.feature,
    current: Number(dev.active) || 0,
  });
  if (denial.allowed) return; // katman/limit istemcide izinli görünüyorsa cümle kurulmaz
  pushPlanLimit(denial);
}

function initSeatGate() {
  if (seatGate) return seatGate;
  const cfg = crewpaneIdConfig(process.env);
  seatGate = createSeatGate({
    authPkg: crewpaneAuth,
    safeStorage: require('electron').safeStorage,
    // ADP-703 — ÖNYÜKLEME KÖKÜ: oturum blob'u hesabı BELİRLER, dolayısıyla hesap
    // kökünün İÇİNDE olamaz (döngü). auth/ cihaz kökünde kalır.
    homeDir: instancePaths.instanceHome(), // instance-aware (~/.crewpane | -test)
    supabaseUrl: cfg.supabaseUrl,
    anonKey: cfg.anonKey,
    scheme: cfg.scheme,
    loginUrl: cfg.loginUrl,
    openExternal: (url) => shell.openExternal(url),
    log: (line) => logLine(line),
    onChange: (snapshot) => pushAccountState(snapshot),
    billingUrl: cfg.billingUrl, // ADP-646 — kapı ekranının "Satın al" hedefi
    // ADP-714 — lansman görünürlüğü: oturum kaydına ürün+sürüm damgası düşsün.
    appVersion: app.getVersion(),
    // ADP-646/SEC-W1-A1 — LİSANS KAPISI: müşteri build'inde HER ZAMAN açık;
    // geliştirici kopyasında escapes.cjs (pakete girmeyen modül) karar verir.
    requireSeat: cfg.requireSeat,
    // ADP-520 — LOGIN DUVARI (0.2.9 gelir kapısı): varsayılan AÇIK. Geliştirici
    // kopyasında kapatılabilir; müşteri build'inde kapatma mantığı PAKETTE YOKTUR.
    requireLogin: cfg.requireLogin,
    // SEC-W2-A2 — BÜTÜNLÜK RAPORU SAĞLAYICISI. seatGate paketin nerede
    // durduğunu bilmez; yalnız "rapor varsa isteğe bindir" der. Karar sunucunun.
    getIntegrityReport: () => integrityReportOnce(),
    // SEC-01 — CİHAZ KİMLİĞİ. Zaten VARDI (ADP-704 çatışma çözümü için üretiliyordu)
    // ama sunucuya hiç gitmiyordu; tek eksik halka buydu. Kimlik hesaptan ÖNCE
    // doğar (kurulum başına kalıcı) — bu yüzden hesap bağlanmasını beklemez.
    device: (() => {
      try {
        return {
          id: accountScope.ensureDeviceId(instancePaths.instanceHome()),
          // Kullanıcı listede kendi makinesini TANIYABİLMELİ; aksi hâlde
          // "hangisini çıkarayım?" sorusu cevapsız kalır ve tavan kilide döner.
          name: `${os.hostname()} · ${process.platform}`,
          platform: process.platform,
        };
      } catch (e) {
        // Kimlik üretilemezse cihaz-farkındalığı DEVRE DIŞI kalır (sunucu eski
        // davranışa düşer) — bir dosya hatası kullanıcıyı kilitlemez.
        logLine(`seatGate: cihaz kimliği okunamadı (${e.message}) — cihaz tavanı bu koşuda uygulanmaz`);
        return null;
      }
    })(),
  });
  logLine(
    `seatGate kurulumu: customerBuild=${cfg.customerBuild} requireLogin=${cfg.requireLogin} requireSeat=${cfg.requireSeat}`,
  );
  // Açılış ağa BEKLETİLMEZ: depodan oku, kararı ver, tazelemeyi arkaya at.
  // ADP-703 — promise SAKLANIR: hesap kökü bağlaması (bindAccountRoot) bunu bekler.
  // Bu bekleme AĞ beklemez (yalnız safeStorage disk okuması), yani açılışı geciktirmez.
  seatGateReady = seatGate.init().catch((e) => {
    logLine(`seatGate init error: ${e.message}`);
    return null;
  });

  // e2e DİKİŞİ — YALNIZ test instance'ında (~/.crewpane-test). Playwright'ın
  // electronApp.evaluate'i MAIN'de koşar; renderer'a hiçbir kanal açılmaz (test'te
  // bile "oturum enjekte et" ucu renderer'dan erişilebilir OLMAMALI). Gerçek
  // magic-link girişi + gerçek callback URL'i buradan sürülür — ürünün KENDİ
  // kod yolları (seatGate.signInWithEmail/handleUrl) çağrılır, e2e kendi kanalını KURMAZ.
  // ADP-646 — `instanceId()` env'den geliyor (CREWPANE_INSTANCE=test), yani müşteri
  // bu dikişi kendi kopyasında AÇTIRABİLİRDİ. Dikiş bir seat VERMEZ (jeton tohumlama
  // ucu yok), ama saldırı yüzeyini bedavaya küçültüyoruz: müşteri build'inde ASLA.
  if (instancePaths.instanceId() === instancePaths.TEST && !buildChannel.isCustomerBuild()) {
    global.__crewpaneAuthTest = {
      state: () => seatGate.evaluate(),
      signInWithEmail: (email) => seatGate.signInWithEmail(email),
      handleUrl: (url) => seatGate.handleUrl(url),
      requireSeat: (action) => seatGate.requireSeat(action),
      refreshLicense: () => seatGate.refreshLicense(),
      signOut: () => seatGate.signOut(),
      // LIC-ENFORCE-01 — GERÇEK kalp atışı kod yolu. e2e 5 dakikayı BEKLEMEZ, ama
      // beklemek zorunda da değil: ürünün zamanlayıcısının çağırdığı FONKSİYONUN
      // AYNISI çağrılır (e2e kendi mekanizmasını KURMAZ). Aralığın gerçekten
      // ~5 dk olduğu ayrıca log'dan doğrulanır.
      heartbeat: () => seatGate.heartbeat(),
      // LIC-ENFORCE-01 (B) — güncelleme kanalının lisans kararı (main'in KENDİ
      // fonksiyonu; renderer'a açılan bir uç değil).
      updateGate: () => updateCheck.updateLicenseGate(seatGate.evaluate()),
      /**
       * ADP-646 — KAÇIŞ BAYRAĞI PROBU. Ürünün KENDİ karar fonksiyonunu, çalışan
       * app'in KENDİ env'iyle (bypass bayrakları dolu) çağırır; tek enjekte edilen
       * şey "paketli müşteri build'i mi" sinyalidir. Kanıt: aynı env, iki sonuç.
       */
      escapeProbe: () => ({
        env: {
          // SEC-W1-A1 — anahtar adları geçersiz kılma modülünden gelir; müşteri
          // paketinde o modül yoktur ve bu nesne BOŞ döner.
          ...devEscapeProbeEnv(process.env),
          CREWPANE_INSTANCE: process.env.CREWPANE_INSTANCE ?? null,
        },
        asCustomer: crewpaneIdConfig(process.env, { customerBuild: true }),
        asDeveloper: crewpaneIdConfig(process.env, { customerBuild: false }),
        actual: crewpaneIdConfig(process.env),
      }),
      /**
       * ADP-660 — PLAN LİMİTİ PROBU. Ürünün KENDİ karar fonksiyonunu, çalışan
       * app'in GERÇEK lisans anlık görüntüsüyle çağırır. `tier` verilirse yalnız
       * katman alanı değiştirilir (jetonu bozup "tanınmayan katman" senaryosunu
       * ölçmek için) — karar mantığı test tarafından TAKLİT EDİLMEZ.
       */
      /**
       * ADP-660 — GÖZETİMSİZ DEVAM boğazının KENDİSİ. Test kendi kopyasını
       * kurmaz: supervisor'a enjekte edilen FONKSİYONUN AYNISI çağrılır. `blocked`
       * sayacı "plan kapattı" ile "renderer cevap vermedi"yi ayırır (ikisi de false).
       */
      supervisorPush: async (channel, payload) => {
        const before = supervisorAdvanceBlocked;
        const ok = await supervisorPushRenderer(channel, payload || {});
        return { ok, blocked: supervisorAdvanceBlocked > before, blockedTotal: supervisorAdvanceBlocked };
      },
      /**
       * BL-01 — DALGA TAVANI boğazının KENDİSİ. Köprüye `onPlanWave` olarak
       * enjekte edilen FONKSİYONUN AYNISI çağrılır (supervisorPush ile aynı
       * disiplin: test ikinci bir kopya kurmaz). Yan etkileri de gerçektir —
       * kısıtlama olduysa log satırı düşer ve nudge EKRANA gider.
       */
      planWaveProbe: (requested) => planWaveLimit(requested),
      /**
       * PLAN-FIX-01 (F-4) — SPAWN NİYET KAPISININ KENDİSİ. `planWaveProbe` deseni:
       * test ikinci bir karar kopyası kurmaz, `spawnPty`'nin AYNISI çağrılır ve
       * yalnız NİYET verilir. Nöbetin ölçtüğü iki şey buradan geçer:
       *   • 'restore' tavandayken → `planLimited` (kaçak KAPALI)
       *   • 'replace' tavandayken → GERÇEK pane (YANLIŞ RET yok — L-7/L-8)
       * Yan etkiler gerçektir (pane açılır); test kendi açtığını kendisi kapatır.
       */
      spawnIntentProbe: (intent, agentId) => {
        const before = ptys.size;
        const res = spawnPty(appWindow, {
          command: 'claude',
          department: 'crewpane',
          agentId: agentId || null,
          forceFresh: true,
          spawnIntent: intent,
        });
        return {
          planLimited: !!(res && res.planLimited),
          paneId: (res && res.paneId) || null,
          reused: !!(res && res.reused),
          liveBefore: before,
          liveAfter: ptys.size,
        };
      },
      /**
       * PLAN-FIX-01 — canlı pane sayısı + DEFTERDEKİ kayıt sayısı (L-5 ölçümü).
       * `restoreSnapshot` DEĞİL, `loadRegistry`: snapshot okuması sahibi HAYATTA
       * olan kayıtları eler (ADP-269) → koşan app kendi defterini 0 görürdü.
       * Nöbetin sorusu "kayıt DURUYOR mu", "şu an restore edilebilir mi" değil.
       */
      paneCensus: () => {
        let ledger = null;
        let file = null;
        try {
          const home = crewpaneHome();
          file = livePaneRegistry.registryPath(home);
          ledger = Object.keys(livePaneRegistry.loadRegistry(home).panes || {}).length;
        } catch { ledger = null; }
        return { live: ptys.size, ledger, file, restoreSkippedByPlan };
      },
      /** PLAN-FIX-01 — bir pane'i GERÇEK kapatma yolundan kapat (L-6: tavanın altına in). */
      killPaneProbe: (paneId) => {
        const entry = ptys.get(paneId);
        if (!entry) return { ok: false };
        killPane(paneId, entry, entry.agentId, 'PLAN-FIX-01 e2e');
        return { ok: true, live: ptys.size };
      },
      /**
       * BL-02 — MOBİL UZAKTAN KONTROL boğazının KENDİSİ. `startMobile()`in ilk
       * satırında çağrılan FONKSİYONUN AYNISI koşar (planWaveProbe deseni): test
       * ikinci bir karar kopyası kurmaz. `notify:false` da açılış yolunun aynısı —
       * ekrana basma zaten kullanıcı eyleminde (`mobile:enable`) ölçülüyor.
       */
      mobilePlanProbe: () => {
        const d = mobilePlanDenial({ notify: false });
        return { denied: !!d, denial: d };
      },
      /**
       * TIER-DESIGN-01 — TASARIM TURU boğazının KENDİSİ. `openDesignWindow()`in
       * ilk satırında çağrılan FONKSİYONUN AYNISI koşar (mobilePlanProbe deseni):
       * test ikinci bir karar kopyası kurmaz. `notify:false` çünkü ekrana basma
       * kullanıcının GERÇEK tıklamasında ayrıca ölçülüyor.
       */
      designPlanProbe: () => {
        const d = designPlanDenial({ notify: false });
        return { denied: !!d, denial: d };
      },
      /** TIER-DESIGN-01 — main defterinde şu an kaç `/design` penceresi var (renderer iddiası DEĞİL). */
      designWindowCount: () => BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed() && /\/design(\?|$)/.test(w.webContents.getURL())).length,
      planProbe: (feature, current, tier) => {
        const snapshot = seatGate.evaluate();
        const s = tier === undefined ? snapshot : { ...snapshot, tier };
        return {
          snapshot: { requireSeat: s.requireSeat, tier: s.tier, seat: s.seat, accessAllowed: s.accessAllowed },
          decision: planLimits.decide({ snapshot: s, feature, current }),
          describe: planLimits.describe(s, { agents: ptys.size }),
        };
      },
    };
  }
  return seatGate;
}

// ─── ADP-703 — HESAP-KAPSAMLI YEREL DEPO (bağlama / geçiş) ────────────────────
//
// ÜRÜN VAADİ (Eren): "bi hesaba girdiysem o hesaptaki değişiklik o hesaba ait tutulur
// ve kaybolmaz; hesap değiştirirsem girdiğim yeni hesabın verileri yüklenir".
//
// Bulut zaten hesap-izole (ADP-623 RLS + ADP-624 company trigger) ama YEREL depo tek
// kökteydi: çıkış yapmak ayarları/hafızayı/pane defterini/delegasyon defterini yerinde
// bırakıyor, sonraki hesap onları AYNEN görüyordu. Burası o eksiği kapatır: veri kökü
// `<instanceHome>/accounts/<accountKey>` olur ve `accountKey` OTURUMDAN türer.
//
// Tasarım + envanter + ADP-704 senkron sözleşmesi: docs/design/ACCOUNT-SCOPED-STORE.md
const accountScope = require('./src/config/accountScope.cjs');
// SYNC-F1-6 — bulut senkronu: kuruluş (syncBoot) + IPC sınırı (syncIpc) + MEMORY.md
// türetme kancası. Üçü de Electron'suz `node --test` ile sınanır.
const syncBoot = require('./sync/syncBoot.cjs');
// SYNC-F1-7 — taşınabilir tercih projeksiyonu (beyaz liste + anahtar-seviyesi LWW).
const prefsProjectorFactory = require('./prefs/prefsProjector.cjs');
const prefsWhitelist = require('./prefs/prefsWhitelist.cjs');
const syncSurface = require('./sync/syncIpc.cjs');
const memoryIndexDerive = require('./src/memory/memoryIndexDerive.cjs');

/** Bu süreçte bağlı hesap — { key, userId, email, root }. Açılışta bir kez set edilir. */
let boundAccount = null;
/** Aynı anda iki bağlama koşmasın (giriş callback'i + açılış yarışabilir). */
let accountBindInFlight = null;

/** seatGate.init()'in TEK promise'i — hesap bağlaması onu bekler (ağ beklemez, disk okur). */
let seatGateReady = null;

/**
 * Hesap kökünü ÇÖZ + BAĞLA. Açılışta (pencere açılmadan) bir kez çağrılır.
 *
 * Sıra kritik: pin (`CREWPANE_ACCOUNT`) her veri modülünden ÖNCE yazılmalı, çünkü
 * `instancePaths.crewpaneHome()` onu okur ve o pin bu sürecin SPAWN ETTİĞİ her çocuğa
 * (ajan pane'leri, MCP server'ları, gömülü Next server) miras geçer — ADP-206'nın
 * CREWPANE_INSTANCE için kanıtlanmış deseni.
 */
async function bindAccountRoot(reason = 'boot') {
  if (accountBindInFlight) return accountBindInFlight;
  accountBindInFlight = (async () => {
    const instanceRoot = instancePaths.instanceHome();
    let snapshot = null;
    try {
      if (seatGateReady) await seatGateReady;
      snapshot = seatGate ? seatGate.evaluate() : null;
    } catch (e) {
      logLine(`[account] oturum okunamadı (${e.message}) — anonim köke bağlanılıyor`);
    }
    // Kimliğe göre HARDCODE yok: anahtar yalnız "userId var mı" durumundan türer.
    const key = accountScope.accountKeyForSession(snapshot);

    // İlk kez hesap-kapsamlı açılış → eski (kapsamsız) veriyi bu hesap DEVRALIR.
    // İdempotent (manifest) + kayıpsız (yalnız rename) + geri alınabilir
    // (scripts/accountScopeRollback.cjs).
    let claim = { claimed: false, alreadyClaimed: true, moved: [], skipped: [] };
    try {
      claim = accountScope.claimLegacyData(instanceRoot, key, { log: (l) => logLine(l) });
    } catch (e) {
      logLine(`[account] eski veri devralınamadı: ${e.message} — mevcut veri OLDUĞU GİBİ bırakıldı`);
    }

    const deviceId = accountScope.ensureDeviceId(instanceRoot);
    let root;
    try {
      root = accountScope.ensureAccountRoot(instanceRoot, key, {
        userId: (snapshot && snapshot.userId) || null,
        email: (snapshot && snapshot.email) || null,
        deviceId,
      });
    } catch (e) {
      logLine(`[account] hesap kökü kurulamadı (${e.message}) — kapsamsız köke düşülüyor`);
      accountBindInFlight = null;
      return null;
    }

    // PIN: ikiz yazım (CREWPANE_ACCOUNT + CREWPANE_ACCOUNT). İkiz-OKUMA yasak —
    // okuma tek yerden: instancePaths.accountKey() (crewpaneEnv PINNED_BASES).
    crewpaneEnv.dualWrite(process.env, 'ACCOUNT', key);
    // ADP-716 — pin YAZILDIĞI AN ayar önbelleğini düşür. `settingsPath()` artık
    // hesap köküne çözülüyor; pin'den önce dolmuş önbellek KAPSAMSIZ kökten geliyor
    // ve bir daha tazelenmiyordu → hesap kökündeki ayarlar (duyuru okundu defteri
    // dahil) yeniden açılışta GÖRÜNMÜYORDU. Bu tek satır o sınıfı kapatır.
    agentSettings.invalidateCache();
    if (_resourceGovernor) {
      try {
        const freshGov = agentSettings.readSettings().resourceGovernor;
        if (freshGov) _resourceGovernor.configure(freshGov);
      } catch (e) {}
    }
    try {
      accountScope.writeActiveAccount(instanceRoot, {
        accountKey: key,
        userId: (snapshot && snapshot.userId) || null,
        email: (snapshot && snapshot.email) || null,
      });
    } catch (e) { logLine(`[account] active-account.json yazılamadı: ${e.message}`); }

    boundAccount = {
      key,
      userId: (snapshot && snapshot.userId) || null,
      email: (snapshot && snapshot.email) || null,
      root,
      deviceId,
    };
    logLine(
      `[account] bağlandı (${reason}): key=${key} signedIn=${!!(snapshot && snapshot.signedIn)} `
      + `kök=${root} devralma=${claim.claimed ? `${claim.moved.length} girdi` : 'gerek yok'}`,
    );
    accountBindInFlight = null;
    return boundAccount;
  })();
  return accountBindInFlight;
}

/**
 * Bu süreçte ÇALIŞAN ajan pane'leri (hesap değişimi uyarısı için).
 * Eren'in açık korkusu: "çıkış yapınca koşan ajanlar bozulur" → çıkış/giriş SESSİZCE
 * yapılmaz; kullanıcı ne olacağını görmeden hesap değişmez.
 */
function runningPaneSummary() {
  const panes = [];
  for (const [paneId, entry] of ptys) {
    if (!entry) continue;
    panes.push({
      paneId,
      agentId: entry.agentId || null,
      label: entry.label || entry.agentId || paneId,
    });
  }
  return panes;
}

/**
 * ADP-863 / ADP-876 — ÇIKIŞ ONAYININ SAYILARI (TEK KAYNAK).
 *
 * Onay ekranı iki soruya cevap vermek zorunda: "kaç şey kapanacak" ve "verim ne olacak".
 * SAYIYI burası verir; CÜMLEYİ sözlük tutar (src/app/i18n → `account.signOut.*`).
 *
 * ADP-876 — cümle BURADAN ÇIKARILDI. Eskiden onay metnini main yazıyordu ve metin
 * TEK DİLLİYDİ: arayüz İngilizceye geçince çıkış akışı Türkçe kalıyordu. Bu diyalog
 * renderer'ın React ağacında yaşıyor (main'in `dialog.show*` kutusu DEĞİL), yani
 * doğru sözlük renderer sözlüğüdür (electron/i18n/dictionaries/en.cjs başlığındaki
 * `main.*` sınırı: main yalnız KENDİ gösterdiği kutuların metnini taşır).
 *
 * İki sayı AYRI şeydir ve kullanıcı ikisini de görmeli:
 *   terminals — açık terminal penceresi sayısı (bir ajanın birden fazlası olabilir)
 *   agents    — o pencerelerde çalışan FARKLI ajan sayısı (ajansız terminal sayılmaz)
 */
function signOutConfirmCopy(panes) {
  const agentIds = new Set();
  for (const p of panes) if (p.agentId) agentIds.add(p.agentId);
  return { terminals: panes.length, agents: agentIds.size };
}

/**
 * ADP-876 — ÇIKIŞTAN ÖNCE PANE'LERİ TEMİZ KAPAT.
 *
 * Ölçülen sorun: onaylı çıkış oturumu kapatıp `app.quit()` çağırıyordu ve terminaller
 * ancak `before-quit` içinde ölüyordu. Yani pane'ler AÇIKKEN hesap kökü değişiyordu;
 * bir pty o aralıkta bir şey yazarsa (ADP-703 §3.1) yazma yanlış hesabın defterine
 * düşerdi. Sıra artık AÇIK: önce ekran kuyruğu + defter yazılır (A hesabı hâlâ bağlı,
 * yani snapshot DOĞRU köke düşer), sonra pty'ler `preserve` ile reap edilir, sonra
 * oturum kapanır. Tekrar giriş yapıldığında pane'ler restore edilebilir kalır.
 */
function closePanesForSignOut() {
  const open = ptys.size;
  if (!open) return 0;
  // ADP-386 sırası: ekran kuyruğu snapshot'tan ÖNCE yazılır ki write-ahead kopya
  // da taşısın (before-quit'teki sıranın aynısı — ikinci bir sıra ikinci bir gerçek).
  persistScreenTails();
  try {
    const n = livePaneRegistry.writeQuitSnapshot(crewpaneHome());
    if (n) logLine(`[signout] pane defteri yazıldı (${n} pane) — hesap kökü DEĞİŞMEDEN önce`);
  } catch (e) { logLine(`[signout] pane defteri yazılamadı: ${e.message}`); }
  killAllPtys(); // preserve=true → restore defteri korunur (veri kaybı yok)
  logLine(`[signout] ${open} pane temiz kapatıldı (oturum kapatılmadan ÖNCE)`);
  return open;
}

/**
 * HESAP DEĞİŞİMİ = YENİDEN BAŞLATMA (bilinçli karar, ACCOUNT-SCOPED-STORE.md §3.3).
 *
 * Canlı geçişte bellekte kalan A verisi B'ye SIZAR ve bunu kapatmak imkânsıza yakın:
 * `ptys` haritası, renderer React state'i, açık pane hücreleri, halihazırda spawn
 * edilmiş MCP çocuklarının env'i — hepsi A'ya bağlıdır; bir sonraki registry yazımı
 * A'nın pane'lerini B'nin defterine yazardı. Yeniden başlatma bu sınıfı YAPISAL olarak
 * siler ve "sızıntı yok" iddiasını kanıtlanabilir kılar.
 *
 * VERİ KAYBI YOK: hiçbir şey silinmez. Kapanış yolu quit-snapshot'ı zaten yazar, yani
 * A'ya tekrar girildiğinde pane'leri restore edilebilir.
 */
// ADP-837 (P7) — YENİDEN BAŞLATMANIN TEK KAPISI.
//
// Üç ayrı yol uygulamayı yeniden başlatıyordu (ayarlar restart'ı, kaynak-derleme
// sonrası relaunch, hesap değişimi) ve üçü de `app.relaunch()`i doğrudan
// çağırıyordu. Windows'ta bu YETMEZ: tek-örnek kilidi (ADR-W5) bırakılmadan
// çıkılırsa yeni kopya kilidi CANLI bulup "CrewPane zaten açık" deyip çıkabilir
// — kullanıcı için "yeniden başlattım, uygulama geri gelmedi". Kilidi bırakma
// işi `app.exit()`in ateşlemediği `will-quit` kancasına bağlıydı; artık AÇIK.
//
// macOS'ta `releaseForRelaunch` ilk satırda döner → davranış bit-bit aynı.
function relaunchApp(reason) {
  try {
    singleInstanceLock.releaseForRelaunch({
      dataRoot: instancePaths.instanceHome(),
      log: (m) => logLine(`[relaunch] ${m}`),
    });
  } catch (e) {
    logLine(`[relaunch] kilit bırakılamadı (${reason}): ${e && e.message}`);
  }
  try {
    app.relaunch();
  } catch (e) {
    logLine(`[relaunch] app.relaunch hatası (${reason}): ${e && e.message}`);
  }
  app.exit(0);
}

function relaunchForAccountChange(nextKey, reason) {
  const instanceRoot = instancePaths.instanceHome();
  try {
    accountScope.writeActiveAccount(instanceRoot, { accountKey: nextKey });
  } catch (e) { logLine(`[account] geçişte active-account yazılamadı: ${e.message}`); }
  // TEST DİKİŞİ (yalnız test instance'ı): e2e harness'ı süreci KENDİ yeniden başlatır —
  // app.relaunch() Playwright'ın kontrol edemediği yetim bir Electron bırakırdı. KARAR
  // mantığı aynıdır (active-account.json yazıldı, süreç kapanıyor); yalnız yeni süreci
  // kimin başlattığı değişir. Müşteri build'inde bu dikiş ERİŞİLEMEZ.
  const suppressRelaunch = instancePaths.instanceId() === instancePaths.TEST
    && !buildChannel.isCustomerBuild()
    && String(process.env.CREWPANE_ACCOUNT_NO_RELAUNCH || '') === '1';
  logLine(`[account] HESAP DEĞİŞİMİ (${reason}): ${boundAccount ? boundAccount.key : '-'} → ${nextKey}`
    + (suppressRelaunch ? ' — süreç kapanıyor (relaunch test dikişiyle bastırıldı)' : ' — uygulama yeniden başlatılıyor'));
  if (!suppressRelaunch) {
    try {
      // ADP-837 — kilit AÇIKÇA bırakılır: `app.quit()` will-quit'i ateşlese de
      // hesap geçişinde iki süreç ömrü üst üste binebilir (Windows).
      singleInstanceLock.releaseForRelaunch({
        dataRoot: instancePaths.instanceHome(),
        log: (m) => logLine(`[account] ${m}`),
      });
    } catch (e) { logLine(`[account] kilit bırakılamadı: ${e.message}`); }
    try {
      app.relaunch();
    } catch (e) { logLine(`[account] relaunch hatası: ${e.message}`); }
  }
  noteQuit('relaunch');
  app.quit();
  // ADP-876 — KAPANIŞ NÖBETÇİSİ. `app.quit()` KİBAR bir istektir: bir pencere
  // kapanışı engellerse (beforeunload kutusu, `close` dinleyicisi, asılı renderer)
  // süreç sonsuza dek yarı-kapalı kalır — kullanıcı için "çıkış yaptım, uygulama
  // kilitlendi". `will-prevent-unload` kancası bilinen sebebi kapatıyor; bu nöbetçi
  // BİLİNMEYENİ kapatır. `before-quit` (snapshot + defter yazımı) quit'in İLK adımıdır,
  // yani bu noktada kalıcılaştırma zaten bitmiştir; kalan tek şey süreci sonlandırmak.
  // HATA-14 — fren ARTIK ORTAK: aynı `armForceExit` normal kapanış yolunda da
  // kuruludur (before-quit). Buradaki çağrı sözleşmeyi GÖRÜNÜR tutar; durum
  // paylaşıldığı için ikinci bir zamanlayıcı KURULMAZ (before-quit `app.quit()`
  // içinde SENKRON ateşlediğinden fren bu satıra gelindiğinde çoktan kurulmuştur).
  armQuitBrake('account-relaunch');
}

/**
 * GİRİŞ sonrası hesap kökü artık başka bir hesaba ait olabilir (A'dayken B ile giriş,
 * ya da anonim kökten ilk giriş). seatGate her durum değişiminde onChange yayar; burada
 * yalnız "bağlı anahtar ≠ oturumun anahtarı" durumunu yakalayıp geçişi tetikleriz.
 * Çıkış yolu KENDİ handler'ında ele alınır (çalışan-ajan guard'ı orada).
 */
function reconcileAccountBinding(snapshot) {
  if (!boundAccount) return; // açılış bağlaması henüz bitmedi
  if (!snapshot || !snapshot.signedIn) return; // çıkış → crewpane:signOut ele alır
  const nextKey = accountScope.accountKeyForSession(snapshot);
  if (nextKey === boundAccount.key) return;
  relaunchForAccountChange(nextKey, 'signIn');
}

// ─── ADP-646 (P0 GÜVENLİK) — LİSANS KAPISININ GERÇEK ÇAĞRI YERLERİ ─────────────
//
// ADP-390'dan beri `requireSeat` yazılıydı ama HİÇBİR YERDEN çağrılmıyordu →
// giriş yapan herkes ücretsiz tam sürümü kullanıyordu. Burası o boşluğu kapatır.
//
// NEDEN BU İKİ NOKTA (ve neden 40 tane değil):
//   * `pty:spawn` — CrewPane'in TEK ajan-çalıştırma boğazı. ADP-487'de zaten
//     kanıtlandı: "spawn kararını veren iki bağımsız renderer yolu vardı, guard'ı
//     BURAYA koymak yarışı YAPISAL olarak kapatır". Delegasyon, Jarvis "tell",
//     manuel açma, sprint dispatch — HEPSİ buradan geçer. Renderer'ı devtools ile
//     kandıran biri bile pane açamaz.
//   * `appdb:token` / bridge `/app-db/token` — görev panosunun ve ajan yolunun
//     KİMLİĞİ. Jeton verilmezse ne görev yazılır ne okunur.
//   * bridge `POST /delegate` — ajan→ajan delegasyon girişi; renderer'a hiç
//     gitmeden temiz bir 402 döner (yoksa IPC timeout'una düşerdi).
// Renderer'daki tam-ekran kapı (CrewPaneLicenseGate) UX'tir; DİŞLER burasıdır.
//
// KAPSAM DIŞI (bilerek): hesap/ayarlar/güncelleme/çıkış yolları. Kilitli kullanıcı
// giriş yapabilmeli, paket alabilmeli, durumunu yenileyebilmeli.

/** Kapıyı sor; kapalıysa çağıranın anlayacağı bir hata FIRLAT (invoke reject olur). */
function requireSeatOrThrow(action) {
  const gate = seatGate ? seatGate.requireSeat(action) : {
    // Gate henüz kurulmadıysa FAIL-CLOSED: "hazır değil" bir lisans-bypass şalteri
    // olamaz. Pratikte erişilmez — initSeatGate() wireIpc()'ten ÖNCE koşar.
    allowed: !crewpaneIdConfig(process.env).requireSeat,
    reason: 'not_ready',
    message: appI18n.t('main.error.seatNotReady'),
  };
  if (gate.allowed) return;
  const err = new Error(gate.message || 'CrewPane paketi gerekli.');
  err.code = 'ERR_SEAT_REQUIRED';
  err.reason = gate.reason;
  throw err;
}

/** Fırlatmayan sürüm — HTTP/IPC gövdesine çevrilecek yerler için. */
function seatDenial(action) {
  const gate = seatGate ? seatGate.requireSeat(action) : { allowed: false, reason: 'not_ready' };
  return gate.allowed ? null : gate;
}

// ─── ADP-660 — PLAN LİMİTİ BOĞAZLARI (Basic ⇄ Pro/Ultra) ────────────────────
// ADP-646 "paketin var mı" sorusunu kapattı; bu katman "HANGİ paket" sorusunu
// kapatır. Ayrım kasıtlı ve UX'te de görünür:
//   erişim yoksa → TAM EKRAN kapı (uygulama kullanılamaz)
//   limit aşıldıysa → yalnız O EYLEM reddedilir + kapatılabilir NUDGE (uygulama açık)
// Bir plan limiti ASLA uygulamayı kilitlemez; kullanıcı çalışmaya devam eder.
//
// Boğazlar (yeni yüzey eklendikçe listeye satır eklenir, politika değişmez):
//   • `pty:spawn`  → eşzamanlı ajan tavanı (ajan çalıştırmanın TEK boğazı, ADP-487)
//   • `integ:add`  → bağlı entegrasyon tavanı (yalnız EKLEME; mevcutlar dokunulmaz)
//   • supervisor `dlgsup:advance` → gözetimsiz devam (otopilot zinciri)
//   • BL-01 `workspace:provision` + `switchWorkspaceRoot` → çalışma alanı tavanı
//     (yalnız YENİ bir kök benimsemede; bilinen köke geçiş limite girmez)
//   • BL-01 köprü `/sprint` → dalga tavanı (REDDETMEZ, dalgayı KISITLAR + söyler)

/** Nudge fırtınası önleyici: aynı yetenek için en fazla 60sn'de bir bildirim. */
const PLAN_NUDGE_MIN_MS = 60_000;
const planNudgeLast = new Map();

/** Reddi renderer'a bildir (kapatılabilir nudge). Ekranı OLMAYAN yollar da çalışır. */
function pushPlanLimit(denial) {
  if (!denial) return;
  // ─── OBS-01 — PLAN LİMİTİ ANALİTİĞİ ────────────────────────────────────────
  // BL serisi Basic'e sınır koydu ama "hangi sınıra kaç kişi çarpıyor, kaçı
  // Pro'ya geçiyor" ÖLÇÜLEMİYORDU — yani sınırların işe yarayıp yaramadığı
  // bilinmiyordu. Yeni bir ölçüm noktası İCAT EDİLMEDİ: reddin ZATEN geçtiği
  // tek yer burası.
  //
  // ⚠️ MUSLUK, NUDGE FRENİNİN ÖNÜNDE. Aşağıdaki `PLAN_NUDGE_MIN_MS` freni bir UI
  // kararıdır ("kullanıcıyı 60 sn'de bir kereden fazla rahatsız etme"), bir ÖLÇÜM
  // kararı değil. Musluğu frenin arkasına koysaydık soru değişirdi: "kaç kez
  // çarpıldı" yerine "kaç kez bildirim gösterildi" ölçülür ve arka arkaya duvara
  // toslayan (yani en çok yükseltmeye yakın olan) kullanıcı EN AZ sayılırdı.
  // Gürültü kapağı analitiğin kendi hız sınırında (analytics.cjs).
  //
  // Kapsam notu (dürüstlük): `planDenial(..., {notify:false})` yolu buraya HİÇ
  // gelmez, dolayısıyla sayılmaz. Bu bilinçli — o yol kullanıcının İSTEMEDİĞİ
  // (açılışta kendiliğinden denenen) bir işin reddidir; onu "duvara çarpma"
  // saymak mobilRemote sayısını açılış gürültüsüyle şişirirdi.
  try {
    const spec = planLimits.FEATURES[denial.feature];
    analyticsNow().track('plan_limit_hit', {
      feature: analyticsSchema.featureOf(denial.feature),
      limit: denial.limit,
      current: denial.current,
      kind: (spec && spec.kind) || 'other',
    });
  } catch { /* analitik reddi bildirmeyi düşüremez */ }
  const last = planNudgeLast.get(denial.feature) || 0;
  const now = Date.now();
  if (now - last < PLAN_NUDGE_MIN_MS) return;
  planNudgeLast.set(denial.feature, now);
  if (appWindow && !appWindow.isDestroyed()) {
    try { appWindow.webContents.send('plan:limit', denial); } catch { /* pencere gitti */ }
  }
}

/**
 * Limit kararı. İzinliyse null, değilse denial nesnesi (metin main'de üretilir) —
 * ve kullanıcı BUNU ekranda görür (sessiz ret yok).
 *
 * BL-02 — `notify:false` YALNIZ kullanıcının İSTEMEDİĞİ bir yol için: açılışta
 * kendiliğinden denenen ve plan yüzünden yapılmayan işler. Gerekçesi ölçüldü:
 * mobil gateway'in açılıştaki otomatik kalkışı reddedilince nudge basıyordu ve
 * (a) hiçbir şey yapmamış kullanıcıyı açılışta yükseltme mesajıyla karşılıyordu
 * (PRICING-PSYCHOLOGY §7: "ilk oturumda tek bir yükseltme duvarı görmez"),
 * (b) `PLAN_NUDGE_MIN_MS` penceresini TÜKETİYORDU — kullanıcı 23sn sonra kendi
 * eliyle "Mobil erişimi aç" dediğinde ret SESSİZ kalıyordu. Karar hiç değişmez,
 * yalnız EKRANA basma hakkı kullanıcının kendi eylemine bırakılır.
 *
 * @param {string} feature - planLimits.FEATURES anahtarı
 * @param {number} [current] - şu anki kullanım
 * @param {{notify?:boolean}} [opts] - notify:false → yalnız log (ekrana basma)
 */
function planDenial(feature, current = 0, { notify = true, variant = null, context = null } = {}) {
  const snapshot = seatGate ? seatGate.state() : null;
  // PLAN-FIX-01 (F-4) — `variant`/`context` YALNIZ CÜMLEYİ seçer; kararı (tavan,
  // hedef katman, allowed) değiştirmez. Metin yine planLimits.cjs'te kalır.
  const decision = planLimits.decide({ snapshot, feature, current, variant, context });
  if (decision.allowed) return null;
  logLine(`planLimits: ${feature} REDDEDİLDİ (katman=${decision.tier} tavan=${decision.limit} kullanım=${decision.current})`);
  if (notify) pushPlanLimit(decision);
  return decision;
}

/**
 * BL-01 — ÇALIŞMA ALANI TAVANI. `integ:add` deseninin birebir aynısı:
 *   1. Hedef kök kullanıcının ZATEN bildiği bir alansa limit HİÇ sorulmaz —
 *      mevcut alanlar arasında gezinmek yeni alan açmak değildir.
 *   2. Sayamıyorsak (ayar okunamadı) limitle uğraşmayız: bir sayım arızası
 *      ödeyen kullanıcıyı kendi klasöründen edemez (KURAL 2, fail-open).
 * @param {string} root - benimsenmek istenen kök
 * @returns {object|null} denial (ekrana da düşer) ya da null (izinli)
 */
function workspacePlanDenial(root) {
  let known;
  try {
    if (workspaceOnboarding.isKnownWorkspace(root)) return null;
    known = workspaceOnboarding.knownWorkspaces();
  } catch (err) {
    logLine(`planLimits: workspaces sayımı okunamadı (${err.message}) — limit UYGULANMADI`);
    return null;
  }
  return planDenial('workspaces', known.length);
}

/**
 * BL-01 — DELEGASYON DALGASI TAVANI. Bir dalga tavanı REDDETMEZ, DARALTIR: sprint
 * durursa müşteri işini kaybeder, oysa ürün vaadi "daha az worker, aynı iş". Lider
 * `maxConcurrent` vermediyse renderer'ın kullanacağı varsayılanla ölçülür (tek
 * kaynak: spawnSpec.SPRINT_DEFAULT_WAVE) — yoksa tavan görünmez biçimde atlanırdı.
 * Kısıtlama SESSİZ DEĞİL: kullanıcı nudge'ı ekranda görür, log'da satır kalır.
 * @param {number|undefined} requested - liderin istediği dalga genişliği
 * @returns {number} uygulanacak dalga genişliği
 */
function planWaveLimit(requested) {
  const asked = Number.isInteger(requested) && requested > 0
    ? requested
    : require('./src/agents/spawnSpec.cjs').SPRINT_DEFAULT_WAVE;
  const snapshot = seatGate ? seatGate.state() : null;
  const { value, clamped, denial } = planLimits.clamp({ snapshot, feature: 'delegateWave', requested: asked });
  if (clamped && denial) {
    logLine(`planLimits: delegateWave KISITLANDI (katman=${denial.tier} tavan=${denial.limit} istenen=${denial.current})`);
    pushPlanLimit(denial);
  }
  return value;
}

/** Benimsenen kökü deftere işle (limit sayımının tabanı). Best-effort. */
function rememberWorkspaceRoot(root) {
  try {
    workspaceOnboarding.rememberWorkspace(root);
  } catch (err) {
    logLine(`workspace defteri yazılamadı (${err.message}) — aktif kök yine bilinir sayılır`);
  }
}

// ─── ADP-584/585/586 — Entegrasyon Merkezi çekirdeği (vault → resolver → IPC) ──
// TEK örnek, TEMBEL kurulum: `safeStorage` app hazır olmadan güvenilir yanıt vermez
// (seatGate ile aynı duruş), ayrıca entegrasyon kullanmayan bir kullanıcıda vault
// dosyasına hiç dokunulmaz. Üç katman ayrı dosyalarda: depolama (credentialVault) —
// politika (integrationResolver) — sınır/doğrulama (integrationIpc).
let integrationsCore = null;
function integrations() {
  if (integrationsCore) return integrationsCore;
  const vault = createCredentialVault({
    safeStorage: require('electron').safeStorage,
    homeDir: instancePaths.crewpaneHome(), // instance-aware (~/.crewpane | -dev | -test)
    log: (line) => logLine(line),
  });
  const resolver = createIntegrationResolver({ vault, log: (line) => logLine(line) });
  const ipc = createIntegrationIpc({
    vault,
    catalog: integrationCatalog,
    redactor: secretRedactor,
    probe: mcpProbe.probeMcpServer,
    // Probe child'ının taban env'i: uygulamanın env'i (PATH/HOME — `npx` bunlarsız
    // koşmaz). integrationIpc bu tabandan CREWPANE_SECRET_* değerlerini ELER
    // (Kural 2: test edilen servis başka bir servisin anahtarını görmez).
    baseEnv: process.env,
    // ADP-848-B — anahtarı BAŞKA yüzey yöneten servisler (bugün: ElevenLabs).
    // Bağlı hesaplar ekranı aynı değeri MASKELİ gösterir; ikinci bir depo YOK.
    // Sır bu fonksiyondan da dışarı çıkmaz — yalnız bayrak + maske döner.
    externalStatus: (service) => {
      const r = credentialGate.resolveCredential(service, { rootDir: REPO_ROOT });
      if (!r.ok) return { connected: false, masked: null };
      return { connected: true, masked: integrationCatalog.maskSecret(r.secret, service) };
    },
    // BR-04 (ADR §6) — vendor/müşteri yüzey ayrımı. Fonksiyon veriyoruz (değer değil):
    // karar her `list()` çağrısında taze alınır, kurulum sırasına bağlı bir yalan olmaz.
    isVendorSurface: () => vendorSurface.isVendorSurface(),
    log: (line) => logLine(line),
  });
  integrationsCore = { vault, resolver, ipc };
  return integrationsCore;
}

/**
 * ENG-08 — motor API anahtarı deposu (ADP-584 vault'unun ince görünümü).
 * MODÜL DÜZEYİNDE: hem spawn boğazı (pane env'i) hem Ayarlar IPC'si AYNI depodan
 * okumak zorunda — iki kopya "Ayarlar kayıtlı der, pane anahtarı görmez" ayrışması
 * demek olurdu. Vault tembel kurulur; hata → `null` (engineAuth dürüstçe
 * 'vault-unavailable' der, sessiz başarı YOK).
 */
function engineKeyStore() {
  try { return engineAuth.createVaultApiKeyStore(integrations().vault); } catch { return null; }
}

// ─── INT-OBS-01 — TELEMETRİ OTOMATİK KURULUMU (Sentry · PostHog) ─────────────
// Kullanıcı Entegrasyon Merkezi'nde tek jeton yapıştırır; gerisini ürün yapar.
// Jeton `integrations().vault`ta (diğer entegrasyonlarla AYNI kasa, AYNI kapı);
// kurulumun ÜRETTİĞİ türev anahtarlar `provisionStore`da (gerekçe o dosyada).
let telemetryProvisionCore = null;
function telemetryProvisioning() {
  if (telemetryProvisionCore) return telemetryProvisionCore;
  const store = provisionStoreMod.createProvisionStore({
    safeStorage: require('electron').safeStorage,
    homeDir: instancePaths.crewpaneHome(),
    log: (line) => logLine(line),
  });
  const provisioner = telemetryProvisionMod.createTelemetryProvisioner({
    store,
    channel: () => telemetryChannelMod.resolveChannel(),
    appVersion: app.getVersion(),
    log: (line) => logLine(line),
  });
  telemetryProvisionCore = { store, provisioner };
  return telemetryProvisionCore;
}

/**
 * Kurulum için jetonu KASADAN çöz. Sır bu fonksiyondan ÇIKAR ama YALNIZ
 * `telemetryProvisioning().provisioner`a gider; renderer'a, log'a, dönüş
 * değerine ASLA girmez (`requireCredential` deseninin aynısı).
 */
function telemetryTokenFor(service) {
  const r = credentialGate.resolveCredential(service, { rootDir: REPO_ROOT });
  return r.ok ? r.secret : null;
}

/** Telemetri env'i — provision store ÜSTTE, `~/.crewpane/telemetry.env` ESKİ yol. */
function telemetryEnvNow() {
  try {
    return telemetryMod.resolveTelemetryEnv({ provisionStore: telemetryProvisioning().store });
  } catch {
    return telemetryMod.loadDsnEnvFromCrewPane({}); // store açılamadıysa eski yol
  }
}

/**
 * BR-01 (ADR-INT-BRIDGE §2) — AJANIN KEŞİF CEVABI.
 *
 * Üç kaynağı birleştirir ve cevabı SAF bir fonksiyona (integrationStatus.cjs) kurdurur:
 *   • katalog        — tam liste (bağlı OLMAYANLAR da döner; "bağlarsan yaparım" cümlesi
 *                      ancak böyle kurulabilir),
 *   • vault.list()   — `toMeta` görünümü: sır YOK, yalnız kapsam/ortam/beyan/damgalar,
 *   • canlı pane     — çağıranın bağlamı (motor/proje/ortam) ve spawn anında ONA
 *                      enjekte edilen servisler.
 *
 * 🔴 Pane bağlamı ÇAĞIRANIN BEYANINDAN alınmaz (ADP-717 dersi): ajan kendi env'ini
 * değiştirebilir; doğru kaynak spawn anında yazılan pane kaydıdır. Ajan pane defterinde
 * bulunamazsa `known:false` → `toolsLiveInThisPane` UYDURULMAZ (null döner).
 */
async function integrationsStatusFor(req = {}) {
  const agentId = typeof req.agentId === 'string' ? req.agentId.trim() : '';
  let paneEntry = null;
  if (agentId) {
    for (const e of ptys.values()) {
      if (e && e.agentId === agentId) { paneEntry = e; break; }
    }
  }
  const paneIntegrations = (paneEntry && paneEntry.integrations) || null;
  const paneEngine = paneEntry ? paneEntry.command : null;
  // ENG-21 (G4) — HÜKÜM TEK EVDEN. Ajanın gördüğü cevap ile pane'in gerçeği aynı
  // fiilden türesin diye enjeksiyon kararı SPAWN YOLUYLA AYNI fonksiyondan okunur
  // (`agentRunner.integrationsInjectable` → `paneCapabilityMatrix.mcpCanCarrySecrets`).
  // Motoru bilmiyorsak (pane defterde yok) hüküm `null` kalır — "çalışmaz" DEMEZ.
  let integrationsInjectable = null;
  let integrationsReason = null;
  if (paneEngine) {
    try {
      integrationsInjectable = agentRunner.integrationsInjectable(paneEngine) === true;
    } catch {
      integrationsInjectable = null; // ölçemedik → iddia etmeyiz
    }
    if (integrationsInjectable === false) {
      // Gerekçe de defterden: rozet metniyle ajana söylenen cümle AYNI kaynaktan.
      try {
        const cell = (paneCapabilityMatrix.buildMatrix(paneEngine) || {}).integrations;
        integrationsReason = (cell && cell.reason) || null;
      } catch {
        integrationsReason = null;
      }
    }
  }
  const pane = {
    agentId: agentId || null,
    engine: paneEngine,
    // MCP-LAZY-01 — profil kapisinin bu pane'de kestikleri (spawn aninda yazildi).
    gated: (paneIntegrations && Array.isArray(paneIntegrations.gated)) ? paneIntegrations.gated : [],
    projectId: paneIntegrations ? paneIntegrations.projectId : null,
    env: paneIntegrations ? paneIntegrations.env : 'dev',
    known: !!paneEntry,
    integrationsInjectable,
    integrationsReason,
  };

  let records = [];
  let vaultAvailable = true;
  try {
    const { vault } = integrations();
    vaultAvailable = vault.isAvailable();
    // `list()` SIR DÖNMEZ (toMeta) — keşif ucu vault'a ikinci bir kimlik yolu açmaz.
    if (vaultAvailable) records = await vault.list();
  } catch (e) {
    logLine(`integrations status: vault okunamadı (${e.message}) — katalog yine de döner`);
    vaultAvailable = false;
  }

  return buildIntegrationsStatus({
    catalog: integrationCatalog,
    records,
    pane,
    injectedServices: paneIntegrations ? paneIntegrations.services : null,
    vaultAvailable,
  });
}

/**
 * BR-01 (ADR §2.4) — "bu anahtar GERÇEKTEN çalıştı" damgası, telemetri doğrulaması
 * yolundan. İkinci damga kaynağı (integ:test) integrationIpc içindedir; ikisi de
 * YALNIZ başarılı bir el sıkışmadan sonra yazar. Anahtar Ayarlar'dan geliyorsa
 * (vault kaydı yok) damga atılmaz — sessizce ve dürüstçe atlanır.
 */
async function stampIntegrationVerified(service) {
  try {
    const { vault } = integrations();
    if (!vault.isAvailable()) return;
    const id = await vault.resolveId(service, {}); // secret'a dokunmadan (resolveId)
    if (id) await vault.markVerified(id);
  } catch (e) {
    logLine(`integrations: doğrulama damgası atılamadı service=${service} (${e.message})`);
  }
}

/** Spawn yolunda kullanılan resolver — kurulum patlarsa spawn ASLA bloklanmaz. */
function integrationResolverOrNull() {
  try {
    return integrations().resolver;
  } catch (e) {
    logLine(`integrations resolver init failed: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CIDX-1 — KOD İNDEKSİ (proje başına aç/kapa, VARSAYILAN KAPALI)
// ═══════════════════════════════════════════════════════════════════════════
// Politika + şema `codeIndex.cjs`te (Electron'suz, test edilebilir); burada YALNIZ
// main'in yapabildiği iki şey var: ayarı okumak (renderer'a güvenilmez) ve ikiliyi
// kullanıcının makinesinde ARAMAK. Enjeksiyonun kendisi agentRunner'ın MEVCUT
// `mcpRegisterArgs` → additive `--mcp-config` zincirinden geçer; burada yeni bir yol
// YOK. Çözümleyici kurulamazsa `null` döner ve spawn bugünkü davranışını korur.
function codeIndexResolverOrNull() {
  try {
    return codeIndexStore.createResolver({
      readSettings: () => agentSettings.readSettings(),
      env: process.env,
      homedir: os.homedir(),
      log: logLine,
    });
  } catch (e) {
    logLine(`kod indeksi çözümleyicisi kurulamadı: ${e.message}`);
    return null;
  }
}

/**
 * CIDX-1 — bir projenin YEREL deposu (Ayarlar→Projeler ile AYNI çözümleyici).
 * Renderer yol dayatamaz (G-1): slug verir, yolu main çözer.
 */
function codeIndexRepoPath(slug) {
  try {
    const repo = projectRepos.resolveProjectRepo(slug, agentWorkspaceRoot, {
      settings: agentSettings.readSettings(), store: worktreeStore, homedir: crewpaneHome(), log: () => {},
    });
    return repo ? repo.repoPath : null;
  } catch { return null; }
}

/**
 * CIDX-1 — TAZELİK ÖLÇÜMÜ (CIDX-0'ın P0'ı burada ürüne bağlanıyor).
 *
 * `index_status` "ready" der ve `head_sha` gösterir — ama o sha CANLI PROBE'dur,
 * indeksin sha'sı DEĞİLDİR (CIDX-0 §3.2: `projects` tablosunda commit alanı yok).
 * Yani araca sorarak "bayat mı?" sorusu YANITLANAMAZ. Bu yüzden indeksi biz
 * kurarken sha'yı KENDİ defterimize yazıyoruz ve tazeliği burada, git ile ölçüyoruz.
 * Ölçülemiyorsa sonuç 'unknown' olur — "taze" diye YUVARLANMAZ (sessiz yalan yok).
 */
function codeIndexFreshness(repoPath, indexedSha) {
  if (!repoPath || !indexedSha) return codeIndexStore.freshness({ indexedSha: indexedSha || null });
  const git = (args) => {
    try {
      return require('node:child_process')
        .execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
        .trim();
    } catch { return null; }
  };
  const headSha = git(['rev-parse', 'HEAD']);
  if (!headSha) return codeIndexStore.freshness({ indexedSha });
  // Değişen dosya = indekslenen commit'ten bugüne DOKUNULMUŞ olanlar + henüz
  // commit'lenmemiş çalışma ağacı. İkincisi olmadan paylaşımlı ağaçta çalışan bir
  // ajan "taze" rozetine bakıp bayat satır aralığı alırdı.
  const committed = git(['diff', '--name-only', `${indexedSha}..HEAD`]);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (committed === null && dirty === null) return { ...codeIndexStore.freshness({ indexedSha }), headSha };
  const files = new Set();
  for (const line of (committed || '').split('\n')) { const f = line.trim(); if (f) files.add(f); }
  for (const line of (dirty || '').split('\n')) { const f = line.slice(3).trim(); if (f) files.add(f); }
  return { ...codeIndexStore.freshness({ indexedSha, headSha, changedFiles: [...files] }), headSha };
}

/** CIDX-1 — koşan indeksleme işleri (slug → child). Aynı projeye İKİ koşum yok. */
const codeIndexJobs = new Map();

// Callback URL'i app hazır olmadan gelebilir (LaunchServices app'i BU URL için açar) →
// sıraya al, gate ayağa kalkınca işle. Kaybolan callback = "giriş çalışmıyor" demek.
const pendingAuthUrls = [];
// ADP-719 — açılışta ölçülen şema sahiplik durumu (crewpane:schemeHealth okur).
let schemeVerdict = null;
/**
 * ADP-954 — ŞEMA KIYASI HARF-DUYARSIZ + DÜŞEN URL SESSİZ DÜŞMEZ.
 *
 * İki ölçülmüş kusur vardı:
 *   1. Kıyas harf-DUYARLIYDI. `deepLinkArgv` bilerek harf-duyarsız kıyaslıyor
 *      (RFC 3986 §3.1: şema harf-duyarsızdır) ve URL'i BOZMADAN veriyor —
 *      yani `CrewPane://auth/callback?...` biçiminde bir dönüş köprüden
 *      geçiyor, sonra BURADA sessizce düşüyordu. Windows'ta taşıyıcı registry/
 *      kabuk olduğu için şemanın harf düzenini bağlantı metni belirler; macOS'ta
 *      LaunchServices normalize ettiği için bu sınıf orada hiç görünmüyordu.
 *   2. Eşleşmeyen URL HİÇ LOGLANMIYORDU → kullanıcı "hiçbir şey olmuyor" der,
 *      logda tek satır yok, teşhis imkânsız. Sorgu dizesi loglanmaz (`code`
 *      tek kullanımlık bir sırdır) — yalnız şema/yol kısmı yazılır.
 */
function handleAuthUrl(url) {
  if (typeof url !== 'string' || !url) return;
  if (!url.toLowerCase().startsWith(APP_URL_PREFIX.toLowerCase())) {
    logLine(`⛔ giriş dönüşü YOKSAYILDI — şema eşleşmedi (beklenen ${APP_URL_PREFIX}, `
      + `gelen ${url.split('?')[0]})`);
    return;
  }
  if (!seatGate) { pendingAuthUrls.push(url); return; }
  seatGate.handleUrl(url).catch((e) => logLine(`seatGate handleUrl error: ${e.message}`));
}
function drainPendingAuthUrls() {
  while (pendingAuthUrls.length) handleAuthUrl(pendingAuthUrls.shift());
}

// ADP-801 — PAKETLİ OTOMASYON OTURUMU OS-YÖNLENDİRMELİ GİRİŞ DÖNÜŞÜNÜ TÜKETMEZ.
// Aynı bundle id'nin birden çok süreci varken OS URL'i hangisine vereceğini bize
// sormaz; dönüş bir test kopyasına düşerse `code` TEK KULLANIMLIK olduğu için orada
// yanar ve kullanıcı "giriş dönüşü gelmedi" görür — sessizce. Tüketmiyoruz ve SEBEBİ
// loga yazılıyor: kullanıcı bağlantıyı kendi penceresine yapıştırarak
// (crewpane:pasteCallback) girişi tamamlayabilir.
//
// ⚠️ Yalnız PAKETLİ koşuda: paketsiz e2e'de OS yönlendirmesi zaten YOKTUR
// (ADP-719 talep etmez, ADP-382 `open scheme://` = -600) → oradaki tek kaynak
// adp520'nin `app.emit('open-url', …)` DİKİŞİdir ve o giriş akışını ölçüyor.
// Paketli bir auth spec'i yazılırsa CREWPANE_E2E_ALLOW_AUTH_URL=1 ile açar.
//
// ADP-833 — aynı kural OS'un ARGV ile getirdiği dönüş için de geçerli (Windows):
// karar tek yerde yaşasın diye buraya çıkarıldı; open-url ve argv aynı kapıdan geçer.
function osAuthUrlBlockedReason(url) {
  if (app.isPackaged && IS_AUTOMATED_SESSION
      && process.env.CREWPANE_E2E_ALLOW_AUTH_URL !== '1'
      && String(url || '').startsWith(APP_URL_PREFIX)) {
    return `otomasyon oturumu (${AUTOMATED_SESSION_REASON})`;
  }
  return null;
}

// ADP-833 (ADR-W6) — WINDOWS DEEP-LINK KÖPRÜSÜ. macOS'ta giriş dönüşü `open-url`
// olayıyla gelir; Windows'ta ÖYLE BİR OLAY YOKTUR — OS uygulamayı URL'i komut
// satırına ekleyerek açar. İki taşıyıcı var, ikisi de BURAYA bağlanır:
//   (a) soğuk açılış → `process.argv` (aşağıda, whenReady içinde),
//   (b) uygulama açıkken → OS yeni bir süreç açar; o süreç kilide takılır ve
//       argv'sini `focus-request.json`a bırakır → birinci kopya `focusWindow`
//       kancasında bu fonksiyonu çağırır (main.js üstü).
// Chromium'un `second-instance` olayı BİLEREK kullanılmıyor: dahili kilit
// `userData` kapsamlıdır (ölçüldü, ADP-832 §2.1) ve dev/test/prod aynı userData'yı
// paylaştığı için onları birbirine bağlardı. O karar korunuyor; köprü onun üstünde.
// `function` (hoisted) + TEMBEL kurulum: `focusWindow` kancası main.js'in ilk
// satırlarında kurulan kilitten çağrılabiliyor, yani bu noktadan ÖNCE. Şema öneki
// de `APP_URL_PREFIX` sabitinden değil `appScheme.cjs`ten okunuyor (aynı değer,
// TDZ yok — o sabit zaten `appSchemePrefix()` ile doldurulur).
let deepLinkConsumer = null;
function consumeArgvDeepLink(argv, source) {
  if (!deepLinkConsumer) {
    deepLinkConsumer = deepLinkArgv.createDeepLinkConsumer({
      prefix: () => require('./src/core/appScheme.cjs').appSchemePrefix(),
      deliver: (url) => handleAuthUrl(url),
      blocked: (url) => osAuthUrlBlockedReason(url),
      log: (line) => logLine(line),
      defer: setImmediate, // gerekçe: createDeepLinkConsumer jsdoc'u (TDZ)
    });
  }
  return deepLinkConsumer(argv, source);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  logLine(`open-url: ${String(url).split('?')[0]}`);
  const blocked = osAuthUrlBlockedReason(url);
  if (blocked) {
    logLine(`⛔ open-url REDDEDİLDİ — ${blocked}. `
      + 'ADP-801: bu dönüş kullanıcının kopyasına ait; test süreci tüketmez.');
    return;
  }
  handleAuthUrl(url);
});

// (ADP-440 — bölge overlay'i, tray penceresi, annotator ve kısayolları kaldırıldı.)

// ADP-121 (ADR-009 Karar 4) — Jarvis activation hotkey. Electron globalShortcut
// only fires on keydown (no keyup), so true hold-to-talk is the widget's hold
// button; this global key is a hands-free TOGGLE that nudges the renderer state
// machine. Best-effort (logs if the combo is already taken by the OS / another app).
const JARVIS_SHORTCUT = 'CommandOrControl+Shift+J';
function registerJarvisShortcut() {
  try {
    const ok = globalShortcut.register(JARVIS_SHORTCUT, () => {
      logLine('global shortcut fired → jarvis toggle');
      try {
        if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('jarvis:hotkey');
      } catch (e) {
        logLine(`jarvis hotkey send error: ${e.message}`);
      }
    });
    logLine(`globalShortcut '${JARVIS_SHORTCUT}' registered=${ok}`);
  } catch (e) {
    logLine(`jarvis globalShortcut register error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// ADP-082 (ADR-006 Karar 1) — workspace file bridge for the embedded code editor.
// ---------------------------------------------------------------------------
// Whitelisted, root-guarded fs surface (same disiplin as ptyApi's command
// whitelist + image:saveTemp's bounds): the sandboxed renderer never touches fs
// directly — only read/write/list through this channel, and ONLY inside the
// workspace root. Path-traversal (`..`), absolute escapes, and symlink-escapes are
// all rejected before any fs call. Size-capped.
// ADP-202/203 — the file bridge below reads the SAME live `agentWorkspaceRoot`
// binding (declared near the top); the old `WORKSPACE_ROOT` alias is gone so a
// live switch (ADP-232-B) can never leave the two out of sync.
const FILE_MAX_BYTES = 5 * 1024 * 1024; // 5 MB — editor opens source files, not blobs

// ADP-103 — "open any folder". The workspace is ALWAYS an active root; the user can
// add MORE roots, but ONLY by picking them in the OS directory dialog (file:openDialog,
// below). read/write/list are guarded to stay inside SOME active root — an arbitrary
// absolute path the user never picked (e.g. /etc/passwd) is still rejected. This keeps
// the sandbox model intact: capability is granted per explicit user choice, not per
// renderer-supplied path. Roots live in this main-side allow-list only (the renderer
// cannot mutate it except through the dialog handler, which forces a real picker).
// ADP-232-C — agentWorkspaceRoot may be NULL (packaged + first run not completed). No
// root → no default active root; every resolver below guards on it and denies with
// a clear reason instead of throwing/mis-rooting into the bundle.
const activeRoots = new Set(agentWorkspaceRoot ? [agentWorkspaceRoot] : []);

// ADP-232-B — roots kept alive ONLY because open panes / running workers were
// spawned there. A live workspace switch grandfathers the previous root here: it
// stays in `activeRoots` (so those panes' file/git access still resolves) and its
// results dir keeps being watched by that pane's window until the pane closes. A
// grandfathered root is never the DEFAULT base for new relative paths — that is
// always the current `agentWorkspaceRoot`.
const grandfatheredRoots = new Set();

/**
 * ADP-232-B — switch the active workspace root LIVE (no app restart). Validates +
 * persists the same way the first-run gate does (workspaceOnboarding.commitWorkspaceRoot:
 * realpath + is-a-dir + not-inside-app-bundle + settings.workspaceRoot write), then
 * applies it in-process:
 *   • the PREVIOUS root is grandfathered (stays in activeRoots) so already-open panes
 *     and in-flight workers keep resolving their files/git under it;
 *   • the NEW root becomes the current base (spawn cwd, relative-path base, memory/
 *     results dirs, git diff) for every subsequent call;
 *   • the active window's reports watcher is rebuilt against the new root;
 *   • a `workspace:changed` event tells the renderer to re-root its tree, reports,
 *     memory graph and Jarvis context.
 * The embedded Next server env (CREWPANE_WORKSPACE_ROOT) is process-lifetime and is
 * NOT re-pointed — see its comment at the top; the desktop file/results surfaces do
 * not depend on it (they go through this main-side root).
 */
function switchWorkspaceRoot(rawRoot) {
  const forbiddenPrefix = app.isPackaged ? process.resourcesPath : null;
  // BL-01 — paket tavanı, kök DEĞİŞTİRİLMEDEN önce. Bilinen bir köke dönüş buradan
  // sessizce geçer (workspacePlanDenial'ın 1. kuralı); yalnız YENİ bir klasörü
  // çalışma alanı yapmak tavana takılır ve kullanıcı nudge'ı EKRANDA görür.
  const planGate = workspacePlanDenial(rawRoot);
  if (planGate) {
    logLine(`workspace:switch REDDEDİLDİ (plan): ${rawRoot} — ${planGate.tier} tavan=${planGate.limit}`);
    return { ok: false, reason: 'plan_limit', error: planGate.message, title: planGate.title,
      limit: planGate.limit, current: planGate.current, tier: planGate.tier,
      requiredTier: planGate.requiredTier, action: 'upgrade' };
  }
  const res = workspaceOnboarding.commitWorkspaceRoot(rawRoot, { forbiddenPrefix });
  if (!res.ok) {
    logLine(`workspace:switch REJECT ${rawRoot} → ${res.reason}`);
    return res;
  }
  rememberWorkspaceRoot(res.root); // BL-01 — artık bilinen bir alan (sayımın tabanı)
  // ADP-946 — SEÇİM DİSKE İNMEDİYSE SESSİZ KALMA. Canlı geçiş yine yapılır (bu
  // oturumda çalışır), ama "yeniden açılışta duracak" İDDİASI artık ölçülmüş bir
  // hükme dayanır. Windows'ta kalıcı EPERM'de kullanıcı eskiden hiçbir uyarı
  // görmeden ilk-açılış kapısına geri dönüyordu.
  if (res.persisted === false) {
    logLine(`workspace:switch ${res.root} — DİSKE YAZILAMADI (${res.persistError}); seçim yalnız bu oturumda geçerli`);
  }
  const transition = workspaceSwitch.applyWorkspaceSwitch({
    current: agentWorkspaceRoot,
    activeRoots,
    grandfathered: grandfatheredRoots,
    next: res.root,
  });
  const previous = transition.previous;
  if (!transition.changed) {
    logLine(`workspace:switch no-op (already ${res.root})`);
    return { ok: true, root: res.root, previous, changed: false, persisted: res.persisted !== false, persistError: res.persistError ?? null };
  }
  agentWorkspaceRoot = transition.current;
  // SKL-B6 — YENİ çalışma alanı ilk kez açılıyor olabilir: dahili skill'ler oraya da
  // kurulur (kanonik depo workspace başınadır — tasarım §2.2 Ç-2).
  seedBuiltinSkills('workspace-switch');
  // SKL-B0 — YENİ kökün motor dizinleri hiç kurulmamış olabilir (kurulum bir yayın
  // fiiline bağlıydı, kök değişimine değil): kök benimsendiği anda eşitle.
  syncSkillEngineViews('workspace-switch');
  // B-02 (§3) — kök değişti: dal cache'inin anahtarı MUTLAK YOL, yani eski
  // köke ait girdiler yeni kökün pane'lerine yanlış dal veremez ama BAYAT da
  // kalırlar (root-guard sonucu dahil). Tek olayda tamamen düşürülür.
  invalidateGitBranchCache();
  // Rebuild every live window's reports watcher against the new root.
  for (const w of BrowserWindow.getAllWindows()) {
    try { w._attachReportsWatcher?.(); } catch { /* window tearing down */ }
  }
  // Tell the renderer(s) to re-root tree / reports / memory / Jarvis context.
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) {
        w.webContents.send('workspace:changed', {
          root: res.root,
          previous: previous ?? null,
          grandfathered: [...grandfatheredRoots],
          at: Date.now(),
        });
      }
    } catch { /* best-effort */ }
  }
  logLine(`workspace:switch ${previous ?? '-'} → ${res.root} (grandfathered ${grandfatheredRoots.size})`);
  return {
    ok: true,
    root: res.root,
    previous: previous ?? null,
    changed: true,
    grandfathered: [...grandfatheredRoots],
    // ADP-946 — renderer bunu görüp "seçim bu oturumda geçerli ama diske
    // yazılamadı" uyarısını basabilsin; sessiz başarı iddiası biter.
    persisted: res.persisted !== false,
    persistError: res.persistError ?? null,
  };
}

/**
 * ADP-852 v3 — P0: HESAP KÖKÜ BAĞLANDIKTAN SONRA ÇALIŞMA ALANINI YENİDEN ÇÖZ.
 *
 * KÖK NEDEN (ölçüldü, repro-R1): `agentWorkspaceRoot` yukarıda MODÜL YÜKLENİRKEN
 * çözülür. O an `process.env.CREWPANE_ACCOUNT` HENÜZ YAZILMAMIŞTIR — pin'i
 * `bindAccountRoot('boot')` yazar (aşağıda, `app.whenReady` içinde). Dolayısıyla boot
 * okuması HESAPSIZ köke (`~/.crewpane/settings.json`) gider; kullanıcının gerçek
 * ayarı ise hesap kökünde (`~/.crewpane/accounts/<key>/settings.json`) yaşar
 * (oraya ADP-703 `claimLegacyData` TAŞIMIŞTIR — yani instance kökünde artık YOKTUR).
 * Sonuç: `agentWorkspaceRoot = null` olarak DONAR ve bir daha sorulmaz.
 *
 * Kullanıcının gördüğü çelişki tam olarak buydu: Ayarlar→Genel ham ayarı okuduğu için
 * klasörü DOLU gösteriyor, Sistem Durumu donmuş `null`'u okuduğu için KIRMIZI
 * "Çalışma klasörü seçilmedi" diyor — ve hiçbir ekran bunu düzeltmenin yolunu vermiyor.
 *
 * `bindAccountRoot` zaten `agentSettings.invalidateCache()` çağırıyor (ADP-716); eksik
 * olan tek şey, o taze ayardan çözülen kökü BU SÜREÇTE benimsemekti. ADP-852'nin
 * kendi dersi burada tekrar ediyor: düzeltmeyi relaunch'a bırakma, aynı süreçte uygula.
 */
function reresolveWorkspaceRootAfterAccountBind() {
  const fallback = app.isPackaged || FORCE_FIRST_RUN ? null : REPO_ROOT;
  const status = agentSettings.configuredWorkspaceRootStatus();
  const next = status.root || fallback;
  if (!next || next === agentWorkspaceRoot) {
    // Kullanılabilir kök YOK: sebebi logla (sessiz kalma) — doctor da aynı hükmü gösterir.
    if (!agentWorkspaceRoot && status.configured) {
      logLine(`workspace: seçili kök KULLANILAMIYOR (${status.reason}${status.code ? `/${status.code}` : ''}): ${status.configured}`);
    }
    return;
  }
  const transition = workspaceSwitch.applyWorkspaceSwitch({
    current: agentWorkspaceRoot,
    activeRoots,
    grandfathered: grandfatheredRoots,
    next,
  });
  if (!transition.changed) return;
  agentWorkspaceRoot = transition.current;
  invalidateGitBranchCache(); // B-02 (§3) — kök değişti, dal cache'i bayat
  logLine(`workspace: hesap bağlandıktan sonra yeniden çözüldü → ${agentWorkspaceRoot} (kaynak=${status.source})`);
}

/**
 * SKL-B0 — MOTOR GÖRÜNÜMLERİNİ EŞİTLE (tetik; fiilin kendisi skillEngineView'da).
 *
 * KÖK NEDEN (ölçüldü, SKILL-LIBRARY-DESIGN §6.2): `reconcileEngineViews` YALNIZ
 * yayın/geri-alma fiilinden çağrılıyordu. Motor defteri ENG-13/ENG-14 ile büyüyünce
 * (gemini · qwen · droid) o fiil bir daha koşmadı ⇒ üç motorun skill dizini HİÇ
 * oluşmadı ve pane'leri yayındaki skilleri GÖRMEDİ (`gemini skills list` →
 * "No skills discovered."). Defter büyümesi bir YAYIN OLAYI DEĞİLDİR; bu yüzden
 * tetik çalışma alanının HAZIR OLDUĞU ana bağlanır, yayına değil.
 *
 * İki çağrı noktası:
 *   • boot             — hesap bağlandıktan SONRA (kök artık kesin)
 *   • workspace-switch — kök değişti, YENİ kökün motor dizinleri hiç kurulmamış olabilir
 *
 * Uygulama sürümü bir SÜREÇ İÇİNDE değişemez (güncelleme yeniden başlatma ister),
 * dolayısıyla "sürüm değişince de koşsun" koşulunu açılış koşusu KAPSAR — sürüm
 * damgası log satırındadır, yani hangi sürümde koştuğu tahmin değil kayıttır.
 */
/**
 * SKL-B6 — DAHİLİ SKILL'LERİ KUR (tetik; fiilin kendisi `builtinSkills.cjs`te).
 *
 * NEDEN AÇILIŞTA: yeni indiren/satın alan kullanıcı uygulamayı ilk açtığında
 * skill'leri HAZIR bulmalı — "kataloğu aç, tek tek kur" bir kurulum adımı olurdu ve
 * ürünün ilk beş dakikası bunu taşımaz. İdempotenttir ve DURUMDAN türer (ilk-açılış
 * bayrağı YOK): kurulu olanı yeniden yazmaz, kullanıcının düzenlediği kopyaya
 * DOKUNMAZ, kullanıcının kaldırdığını GERİ KURMAZ (`optOut` defteri).
 *
 * Sürüm yükseltmesi de aynı yoldan geçer: yeni skill kurulur, el değmemiş kopya
 * tazelenir, çatal korunur ve "güncelleme bekliyor" olarak raporlanır.
 *
 * ASLA FIRLATMAZ: tohumlama bir açılış adımıdır; düşerse uygulama açılmaya devam eder.
 */
function seedBuiltinSkills(reason) {
  try {
    return builtinSkills.ensureInstalled({
      workspaceRoot: agentWorkspaceRoot,
      reviewedBy: 'builtin-catalog',
      log: (line) => logLine(`builtin-skills[${reason}] ${line.replace(/^builtin-skills /, '')}`),
    });
  } catch (err) {
    logLine(`builtin-skills[${reason}] tetik hatası: ${err.message}`);
    return { ran: false, reason: 'error', error: err.message, installed: [], updated: [], preserved: [], pending: [], conflicts: [], failed: [] };
  }
}

function syncSkillEngineViews(reason) {
  try {
    return skillEngineSync.syncEngineViews({
      workspaceRoot: agentWorkspaceRoot,
      appVersion: app.getVersion(),
      reason,
      log: (line) => logLine(line),
    });
  } catch (err) {
    // Eşitleme bir açılış adımıdır: düşerse uygulama açılmaya DEVAM eder.
    logLine(`skill-views[${reason}] tetik hatası: ${err.message}`);
    return { ran: false, reason: 'error', error: err.message, report: null, summary: null };
  }
}

/** True iff `abs` is the workspace root itself or strictly inside it. */
function withinWorkspace(abs) {
  if (!agentWorkspaceRoot) return false; // ADP-232-C — unconfigured: nothing is "in the workspace"
  const rootWithSep = agentWorkspaceRoot.endsWith(path.sep) ? agentWorkspaceRoot : agentWorkspaceRoot + path.sep;
  return abs === agentWorkspaceRoot || abs.startsWith(rootWithSep);
}

/** True iff `abs` is, or is strictly inside, ANY currently-active root. */
function withinActiveRoots(abs) {
  for (const root of activeRoots) {
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (abs === root || abs.startsWith(rootWithSep)) return true;
  }
  return false;
}

/**
 * Resolve a renderer-supplied path and reject anything outside EVERY active root.
 * Relative paths resolve under the workspace root (backward compat with the
 * workspace-relative tree); absolute paths are normalized then range-checked against
 * the active-root allow-list. Returns the absolute path, or null if denied.
 * (Symlink-escape is checked separately by the caller via realpath, since the
 * target may not exist yet for a write.)
 */
function resolveInRoots(p) {
  if (typeof p !== 'string' || p.length === 0) return null;
  // ADP-232-C — no workspace root: relative paths have no base to resolve under →
  // deny (absolute paths can still hit a user-opened active root).
  if (!path.isAbsolute(p) && !agentWorkspaceRoot) return null;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(agentWorkspaceRoot, p);
  return withinActiveRoots(abs) ? abs : null;
}

// ADP-402 — pane cwd → saran git repo'nun branch adı (pane header rozeti).
// `git` subprocess'i yerine .git/HEAD dosyası okunur (maliyet mikrosaniye);
// yukarı yürüyüş aktif-root sandbox'ının DIŞINA çıkmaz (dışarıdaki bir üst
// repo'nun bilgisi sızmasın). Worktree (.git DOSYA: "gitdir: …") desteklenir;
// detached HEAD → kısa hash gösterilir.
const GIT_BRANCH_TTL_MS = 5000;
const gitBranchCache = new Map(); // abs cwd → { at, value }

/**
 * B-02 (§3) — TTL'i BEKLEMEDEN tazele.
 *
 * 5 saniyelik cache ADP-284'ün boşta-CPU disiplini için doğru, ama merge/worktree
 * geçişi gibi ANLARDA yanlış: rozet 5 saniye boyunca ARTIK GEÇERSİZ bir dal adı
 * gösterir ve kullanıcı "hangi daldayım" sorusunu yanlış cevaplar. Bu yüzden cache
 * OLAYLA düşürülür (yeni bir poll döngüsü EKLENMEZ — spec'in açık yasağı):
 *   • merge başarıyla indi        (worktree:merge)
 *   • worktree serbest bırakıldı  (worktree:release)
 *   • çalışma alanı değişti       (workspace:switch)
 *   • yeni pane doğdu             (spawnPty)
 * Renderer ayrıca `git:branch(cwd, { force: true })` ile aynı şeyi kendi
 * olaylarında (görev değişimi, attach) isteyebilir.
 */
function invalidateGitBranchCache(absDir) {
  if (typeof absDir === 'string' && absDir) gitBranchCache.delete(path.resolve(absDir));
  else gitBranchCache.clear();
}

function readGitBranch(startDir) {
  let dir = startDir;
  for (let i = 0; i < 40; i++) {
    if (!withinActiveRoots(dir)) return null;
    const dotGit = path.join(dir, '.git');
    try {
      const st = fs.statSync(dotGit);
      let headPath;
      if (st.isDirectory()) {
        headPath = path.join(dotGit, 'HEAD');
      } else {
        const gitdir = fs.readFileSync(dotGit, 'utf8').trim().replace(/^gitdir:\s*/, '');
        headPath = path.join(path.isAbsolute(gitdir) ? gitdir : path.resolve(dir, gitdir), 'HEAD');
      }
      const head = fs.readFileSync(headPath, 'utf8').trim();
      const ref = head.match(/^ref: refs\/heads\/(.+)$/);
      return ref ? ref[1] : head.slice(0, 7);
    } catch {
      /* bu seviyede .git yok/okunamadı → bir üst dizine */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * TASK-MQTIVZSDYPNRH — resolve the editor-supplied "active workspace" (a file path or a
 * folder, workspace-relative or absolute) to a DIRECTORY inside an active root, for the
 * search bridge to scope to. A file → its parent dir; anything denied/missing → the
 * workspace root. codeIntel then narrows to the enclosing git repo. Never escapes the
 * active-root sandbox.
 */
function resolveSearchRoot(p) {
  const abs = resolveInRoots(p);
  if (abs) {
    try {
      return fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
    } catch {
      /* missing → fall through */
    }
  }
  return agentWorkspaceRoot;
}

/**
 * The path form handed back to the renderer: workspace-relative for in-workspace
 * paths (so the existing tree/tabs keep their familiar `docs/…` labels), and the
 * ABSOLUTE path for anything under a user-opened root (the renderer round-trips it
 * straight back through read/write/list — both forms resolve here).
 */
function displayPath(abs) {
  return withinWorkspace(abs) ? (path.relative(agentWorkspaceRoot, abs) || '.') : abs;
}

/** Read a file inside any active root as UTF-8. `{ ok, content, encoding, path }` or `{ ok:false, reason }`. */
function readWorkspaceFile(p) {
  try {
    const abs = resolveInRoots(p);
    if (!abs) return { ok: false, reason: 'path-denied' };
    // Symlink-escape guard: an existing path's REAL location must stay in an active root.
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    if (!withinActiveRoots(real)) return { ok: false, reason: 'path-denied' };
    const st = fs.statSync(real);
    if (st.isDirectory()) return { ok: false, reason: 'is-directory' };
    if (st.size > FILE_MAX_BYTES) return { ok: false, reason: 'too-large' };
    const content = fs.readFileSync(real, 'utf8');
    logLine(`file:read ${displayPath(real)} (${st.size} bytes)`);
    return { ok: true, content, encoding: 'utf8', path: displayPath(real) };
  } catch (err) {
    return { ok: false, reason: 'read-failed', detail: err.message };
  }
}

/** Write UTF-8 content to a file inside any active root. `{ ok, bytes, path }` or `{ ok:false, reason }`. */
function writeWorkspaceFile(payload) {
  try {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad-request' };
    const { path: p, content } = payload;
    if (typeof content !== 'string') return { ok: false, reason: 'bad-data' };
    const abs = resolveInRoots(p);
    if (!abs) return { ok: false, reason: 'path-denied' };
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > FILE_MAX_BYTES) return { ok: false, reason: 'too-large' };
    // Symlink-escape guard for the PARENT dir (a new file) and the file itself
    // (an existing symlink): both REAL locations must stay in an active root.
    const parent = path.dirname(abs);
    const realParent = fs.existsSync(parent) ? fs.realpathSync(parent) : parent;
    if (!withinActiveRoots(realParent)) return { ok: false, reason: 'path-denied' };
    if (fs.existsSync(abs) && !withinActiveRoots(fs.realpathSync(abs))) {
      return { ok: false, reason: 'path-denied' };
    }
    fs.writeFileSync(abs, content, 'utf8');
    logLine(`file:write ${displayPath(abs)} (${bytes} bytes)`);
    return { ok: true, bytes, path: displayPath(abs) };
  } catch (err) {
    return { ok: false, reason: 'write-failed', detail: err.message };
  }
}

/** List a directory inside any active root (files + dirs, hidden + node_modules skipped). */
function listWorkspaceDir(dir) {
  try {
    const abs = resolveInRoots(dir == null || dir === '' ? '.' : dir);
    if (!abs) return { ok: false, reason: 'path-denied' };
    const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
    if (!withinActiveRoots(real)) return { ok: false, reason: 'path-denied' };
    const st = fs.statSync(real);
    if (!st.isDirectory()) return { ok: false, reason: 'not-a-directory' };
    const entries = fs
      .readdirSync(real, { withFileTypes: true })
      .filter((d) => !d.name.startsWith('.') && d.name !== 'node_modules')
      .map((d) => ({
        name: d.name,
        path: displayPath(path.join(real, d.name)),
        type: d.isDirectory() ? 'dir' : 'file',
      }))
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, dir: displayPath(real), entries };
  } catch (err) {
    return { ok: false, reason: 'list-failed', detail: err.message };
  }
}

/**
 * ADP-103 — open the OS directory picker and ADD the chosen dir to the active-root
 * allow-list, so the tree can browse outside the workspace. The renderer never
 * supplies the path: only what the user picks in the native dialog becomes a root
 * (capability-by-user-choice; no renderer-driven root injection). Returns the new
 * root's display path + basename, or `{ ok:false, reason }` (canceled/not-a-dir).
 */
async function openFolderDialog(win) {
  let result;
  try {
    result = await dialog.showOpenDialog(win ?? undefined, {
      title: appI18n.t('main.dialog.openFolder.title'),
      properties: ['openDirectory', 'createDirectory'],
    });
  } catch (err) {
    return { ok: false, reason: 'dialog-failed', detail: err.message };
  }
  if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
    return { ok: false, reason: 'canceled' };
  }
  let chosen = result.filePaths[0];
  try { chosen = fs.realpathSync(chosen); } catch { /* dir must exist; fall through to stat */ }
  try {
    if (!fs.statSync(chosen).isDirectory()) return { ok: false, reason: 'not-a-directory' };
  } catch (err) {
    return { ok: false, reason: 'read-failed', detail: err.message };
  }
  activeRoots.add(chosen);
  persistGrantedRoots(); // ADP-109 — remember it so a restart can restore this root
  logLine(`file:openDialog added root ${chosen}`);
  return { ok: true, root: displayPath(chosen), name: path.basename(chosen) || chosen };
}

/**
 * ADP-108 — grant the editor read access to a WATCHED pane's working directory.
 * The capability is keyed to a pane MAIN ITSELF spawned (the renderer supplies only
 * a paneId, never a path), so this preserves the ADP-103 sandbox model: a root is
 * added only for a real, main-known cwd — not an arbitrary renderer-supplied path.
 *
 * Why: a watched agent's spawn cwd defaults to HOME (sanitizeCwd), so when it writes
 * a relative path ("oyun/x.html") the file lands at <cwd>/oyun/x.html, OUTSIDE the
 * crewpane/ workspace root. The editor's fileApi only resolves inside active roots,
 * so it never found the file (the false-PASS root cause). Adding the pane's cwd as a
 * root — and returning it + HOME + the workspace root — lets the renderer rebase the
 * printed path to an absolute path the editor can open WHEREVER the agent wrote it.
 * Returns the ABSOLUTE cwd (not displayPath) so the renderer can join relative paths.
 */
function allowPaneRoot(paneId) {
  const entry = ptys.get(paneId);
  if (!entry) return { ok: false, reason: 'no-pane' };
  let cwd = entry.cwd;
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, reason: 'no-cwd' };
  try { cwd = fs.realpathSync(cwd); } catch { /* cwd may be gone; use as recorded */ }
  activeRoots.add(cwd);
  logLine(`file:allowPaneRoot paneId=${paneId} root=${cwd}`);
  return { ok: true, cwd, home: os.homedir(), workspaceRoot: agentWorkspaceRoot };
}

// ADP-109 — origin-stable editor state (last-session + recent) under userData. A single
// JSON blob `{ recent, session }`; the renderer owns its shape (we just persist it).
function editorStatePath() {
  return path.join(app.getPath('userData'), 'editor-state.json');
}

// ADP-109 — persist the user-GRANTED external roots (ADP-103 dialog picks) so the
// editor's last-session restore can re-list / re-open a folder across a real restart.
// Security model is unchanged: a path lands here ONLY after the user picked it in the
// OS dialog at least once (renderer-supplied paths still can't add roots). On startup
// we re-validate each (realpath + still-a-directory) before re-granting.
function grantedRootsPath() {
  return path.join(app.getPath('userData'), 'editor-granted-roots.json');
}
function persistGrantedRoots() {
  try {
    const extra = [...activeRoots].filter((r) => r !== agentWorkspaceRoot);
    fs.writeFileSync(grantedRootsPath(), JSON.stringify(extra), 'utf8');
  } catch { /* best-effort */ }
}
function rehydrateGrantedRoots() {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(grantedRootsPath(), 'utf8'));
  } catch {
    return; // none saved
  }
  if (!Array.isArray(list)) return;
  for (const r of list) {
    if (typeof r !== 'string') continue;
    let abs = r;
    try { abs = fs.realpathSync(r); } catch { continue; } // gone → don't re-grant
    try { if (!fs.statSync(abs).isDirectory()) continue; } catch { continue; }
    activeRoots.add(abs);
  }
  logLine(`rehydrated ${activeRoots.size - 1} granted editor root(s)`);
}
function readEditorState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(editorStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null; // missing / malformed → "no history"
  }
}

// ADP-437 — office layout/floor/custom-asset persistence. userData, NOT localStorage:
// the embedded Next server binds a RANDOM free port each launch, so the renderer
// origin changes every restart and localStorage-saved furniture silently vanished.
// Same store discipline as editorState; atomic write (tmp+rename) because this file
// holds the user's hand-built office (a torn write must not eat it).
function officeStatePath() {
  return path.join(app.getPath('userData'), 'office-state.json');
}
// FDBK-F1 — filigran dosyası (office-state ile aynı kalıp: userData + atomik yazım).
function feedbackSeenPath() {
  return path.join(app.getPath('userData'), 'feedback-seen.json');
}
function readFeedbackSeen() {
  try {
    const parsed = JSON.parse(fs.readFileSync(feedbackSeenPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // yok/bozuk → renderer boş filigranla başlar (en fazla bir fazla duyuru)
  }
}
function writeFeedbackSeen(state) {
  try {
    const file = feedbackSeenPath();
    if (state == null) {
      try { fs.unlinkSync(file); } catch { /* zaten yok */ }
      return { ok: true };
    }
    if (typeof state !== 'object' || Array.isArray(state)) return { ok: false, error: 'invalid' };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameWithRetrySync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}
function readOfficeState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(officeStatePath(), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null; // missing / malformed → renderer falls back to defaults
  }
}
function writeOfficeState(state) {
  try {
    const file = officeStatePath();
    if (state == null) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
      return { ok: true };
    }
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    renameWithRetrySync(tmp, file);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}
function writeEditorState(state) {
  try {
    if (state == null) {
      try { fs.unlinkSync(editorStatePath()); } catch { /* already gone */ }
      return { ok: true };
    }
    fs.writeFileSync(editorStatePath(), JSON.stringify(state), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

// ADP-487 — tek-aktif-pane-per-agent: bir agentId'nin CANLI (exit olmamış) pane'i
// varsa döndür, yoksa null. `restoreLivePanes`'in kendi "double-spawn guard"ı
// (ADP-133 deseni, satır ~3740) ile AYNI kontrol — burada yeniden kullanılabilir
// hale getirildi ki TEK bir yerden (bu fonksiyon) hem restore hem canlı spawn IPC'si
// aynı gerçeği sorgulasın.
/** ADP-896 — görev kapısının okuduğu canlı-pane görünümü (saf karar main'de kalsın). */
/**
 * ENG-OPENCODE-DB-01 (C4) — canlı pane'lerin ürün-üretimi yerel depo dosyaları
 * (`ptys[*].isolationFile`, null'lar düşer). İkiz kapısının TEK girdisi; kararın
 * kendisi `taskClaim.decideIsolationTwin` (saf) → `agentRunner.applyPaneIsolationEnv`.
 */
function liveIsolationFiles() {
  const out = [];
  for (const entry of ptys.values()) {
    if (entry && typeof entry.isolationFile === 'string' && entry.isolationFile) out.push(entry.isolationFile);
  }
  return out;
}

function livePanesForClaim() {
  const rows = [];
  for (const [paneId, entry] of ptys) {
    rows.push({ paneId, agentId: entry.agentId ?? null, label: entry.label ?? null, stalled: entry.stalled === true });
  }
  return rows;
}

function findLivePaneForAgent(agentId) {
  if (!agentId) return null;
  for (const [paneId, entry] of ptys) {
    if (entry.agentId === agentId) return { paneId, entry };
  }
  return null;
}

/**
 * ADP-761 — TEK DEDUPE KARARI (tek uygulama, iki çağıran).
 *
 * ADP-487 guard'ı `pty:spawn` IPC HANDLER'ına konmuştu; ama `spawnPty` IPC'den
 * BAĞIMSIZ olarak da çağrılıyor (restore, kurtarma teklifi, ölü-oturum fallback'i,
 * pty-resume daemon respawn'ı). O yolların her biri KENDİ ad-hoc "bu ajan zaten
 * canlı mı" kontrolünü taşıyor — yani beş ayrı kopya, sıfır merkezi kapı: tam da
 * ADP-487'nin kapatmaya çalıştığı desen (dağıtık kopyalar SAPAR). Karar artık TEK
 * fonksiyonda; `pty:spawn` onu SIRA gereği önce çağırır (dedupe → plan limiti:
 * mevcut ajanla konuşmak yeni ajan açmak değildir), `spawnPty` ise YAPISAL ARKA
 * DURAK olarak çağırır — hangi yol gelirse gelsin duplikasyon imkânsız.
 *
 * `forceFresh` — ADP-289 karantina istisnası (stalled pane'e ASLA yazma, KURAL-1):
 * çağıran "ikinci pane'i BİLEREK istiyorum" der. Bayrak yoksa mevcut pane REUSE edilir.
 * ADP-953 — bayrak artık TEK BAŞINA yetmez: `freshReason` ile sebep bildirilir ve
 * 'quarantine' iddiası main'in KENDİ `entry.stalled` defterine karşı DOĞRULANIR
 * (doğrulanmazsa ikinci pane açılmaz). Bkz. aşağıdaki forceFresh bloğu.
 *
 * @returns {null | object} reuse yükü (spawn edilmeyecek) ya da null (spawn devam).
 */
function dedupeSpawnForAgent(opts, why) {
  const agentId = typeof opts?.agentId === 'string' ? opts.agentId.trim() : '';
  if (!agentId) return null;
  // ADP-896 — GÖREV KAPISI, ajan kapısından ÖNCE. `forceFresh` ajan-tekilliğini
  // bilerek atlar (ADP-289 karantina) ama "aynı GÖREV zaten uçuşta mı" sorusu HİÇ
  // sorulmuyordu → aynı ADP koduyla ikiz pane (pane-122↔128, pane-125↔127) ve aynı
  // repoda paralel iki worker. Takılı pane'in kurtarılması İSTİSNA olarak geçer.
  const claim = taskClaim.decideSpawn(livePanesForClaim(), opts);
  if (claim.action === 'reuse') {
    const existing = ptys.get(claim.paneId);
    if (existing) {
      logLine(`pty:spawn GÖREV KİLİDİ (${why}) agentId=${agentId} — ${claim.why}`);
      return {
        paneId: claim.paneId,
        pid: existing.pid,
        command: existing.command,
        shell: existing.command,
        agentId: existing.agentId ?? null,
        department: existing.department ?? null,
        cwd: existing.cwd ?? null,
        model: existing.launchModel ?? null,
        reused: true,
      };
    }
  } else if (claim.code && claim.paneId) {
    logLine(`pty:spawn görev kapısı GEÇİRDİ (${why}) agentId=${agentId} — ${claim.why}`);
  }
  if (opts?.forceFresh === true) {
    // ADP-761 — İKİNCİ PANE'İN DOĞDUĞU AN: tek yer burası. Eskiden bu olay hiçbir iz
    // bırakmıyordu; "neden bu ajanın 2 terminali var?" sorusu ancak defter dosyalarını
    // ve `pty spawned` satırlarını elle eşleştirerek (40 dakikalık adli inceleme)
    // yanıtlanabiliyordu.
    const twin = findLivePaneForAgent(agentId);
    if (twin) {
      // ADP-953 — `forceFresh` ARTIK BİR İDDİADIR, ÖLÇÜLMÜŞ BİR GERÇEK DEĞİL.
      //
      // Eskiden bayrak kapıyı KOŞULSUZ açıyordu: çağıran "bu pane takılı" derse main
      // sorgusuz ikinci pane veriyordu. Windows'ta tam da bu iddia YALAN çıkıyordu —
      // ConPTY yeniden çizimi worker'ın `DONE:` satırını gizleyip pane'i sahte
      // `stalled` yapıyor, sıradaki dispatch de o sahte duruma dayanıp `forceFresh`
      // gönderiyordu (kök neden delegationSupervisor.markerCount + delegation.ts ANSI
      // deliğinde düzeltildi). ADP-487'nin dersi burada bir kez daha uygulanır:
      // KAPI ÇAĞIRANIN İDDİASINA DEĞİL, KENDİ DEFTERİNE BAKAR.
      //
      // Üç MEŞRU sebep ayrı ayrı adlandırılır (sözleşmeyi genişletmek yerine ALAN
      // ekleme deseni — ADP-321/761):
      //   • 'quarantine' (ADP-289) → İDDİA DOĞRULANIR: main'in kendi `entry.stalled`ı
      //     da takılı demiyorsa bayrak REDDEDİLİR ve pane REUSE edilir.
      //   • 'replace' (ADP-761) → çağıran eski pane'i AZ ÖNCE kapattı; kapanış asenkron
      //     olduğu için kapı bilerek atlanır. Hangi pane olduğu `retirePaneId` ile
      //     BİLDİRİLİR — "herhangi bir ikinci pane" yetkisi değildir.
      //   • 'recovery' (ADP-705) → teslimat doğrulaması başarısız; kanıt main'de YOK
      //     (renderer'ın delivery state'i) ve bütçe alt-görev başına BİR pane.
      // Sebep bildirilmemişse en dar yorum uygulanır: 'quarantine' (yani doğrulanır).
      // Karar SAF ve test edilebilir (taskClaim.cjs — `node --test`); burada yalnız
      // main'in defteri (`entry.stalled`) girdi olarak verilir.
      const verdict = taskClaim.decideForceFresh(
        { paneId: twin.paneId, stalled: twin.entry.stalled === true },
        opts,
      );
      if (!verdict.honored) {
        logLine(
          `pty:spawn forceFresh REDDEDİLDİ (${why}) agentId=${agentId} sebep=${verdict.reason} — ${verdict.why}`,
        );
        const e = twin.entry;
        return {
          paneId: twin.paneId,
          pid: e.pid,
          command: e.command,
          shell: e.command,
          agentId: e.agentId ?? null,
          department: e.department ?? null,
          cwd: e.cwd ?? null,
          model: e.launchModel ?? null,
          reused: true,
        };
      }
      logLine(
        `pty:spawn İKİNCİ PANE (forceFresh/${verdict.reason}, ${why}) agentId=${agentId} — ${verdict.why}; ` +
          `mevcut canlı pane ${twin.paneId} DURUYOR. ` +
          'Bu pane\'i geri kazanmak supervisor hayalet-reap\'inin ya da operatörün işi.',
      );
    }
    return null;
  }
  const existing = findLivePaneForAgent(agentId);
  if (!existing) return null;
  const e = existing.entry;
  logLine(
    `pty:spawn DEDUPED (${why}) agentId=${agentId} → reusing existing paneId=${existing.paneId} ` +
      `(would have opened a duplicate; caller did not set forceFresh)`,
  );
  return {
    paneId: existing.paneId,
    pid: e.pid,
    command: e.command,
    shell: e.command,
    agentId: e.agentId ?? null,
    department: e.department ?? null,
    cwd: e.cwd ?? null, // ADP-502 — reuse'da da gerçek spawn-cwd döner
    model: e.launchModel ?? null,
    reused: true,
  };
}

/**
 * ADP-595 — the codex custom-provider REGISTRY as the renderer sees it. The renderer
 * (çalışan formu: motor × sağlayıcı × model) must NOT keep its own list — it reads
 * THIS, whose single source is `electron/providers.cjs` (ADP-580). Adding a provider
 * there makes it appear in the UI with no renderer change.
 *
 * SECRET-SAFE: only `hasKey` (presence), never the key itself — the ADP-580 discipline.
 * `needsShim` + `adapterReady` are STATE, not names: the UI derives "kullanılabilir mi"
 * from them (ADP-594's responses→chat adapter must be listening before a needsShim
 * provider can serve a request). A name-based hardcode in the UI is forbidden.
 */
/**
 * AGENT-MODEL-01 — MOTOR BAŞINA MODEL + EFOR SEÇENEKLERİ (ajan formu bunu çizer).
 *
 * NEDEN MAIN'DE: katalog kaynaklarından biri bir DOSYA (`~/.codex/models_cache.json`);
 * renderer diske bakamaz. Ayrıca EFOR beyaz listesinin tek kaynağı engineRegistry'dir
 * ve o da main tarafındadır. İkisini burada BİRLEŞTİRİP göndermek, UI'ın iki kuralı
 * kopyalamasını (ve zamanla ıraksamasını) engeller.
 *
 * 🪤 EFOR KÜMESİ MODEL BAŞINA: codex kataloğu her model için
 * `supported_reasoning_levels` taşır ve bu motorun taşıyıcı kümesiyle KESİŞTİRİLİR
 * (`modelCatalog.effortChoices`). Kesişim boşsa UI efor seçicisini HİÇ çizmez —
 * uygulanamayacak bir kontrol sunmak, bu kod tabanının yasakladığı sessiz
 * başarısızlıktır.
 *
 * `usable`: aiProvidersPayload ile AYNI kural — spawn'ın kendi biçim-whitelist'i
 * (`agentRunner.sanitizeModel`) sorulur, UI kural KOPYALAMAZ.
 */
function engineModelCatalogPayload() {
  const out = {};
  for (const id of engineRegistry.engineIds()) {
    const cat = modelCatalog.catalogFor(id);
    const effortCap = engineRegistry.capability(id, 'effort');
    const engineEfforts = effortCap && Array.isArray(effortCap.values) ? [...effortCap.values] : [];
    out[id] = {
      source: cat.source,
      // Katalog dosyası okunamadı/boş (codex hiç koşmamış) → UI "liste alınamadı"
      // diyebilsin; "model yok" ile "liste gelmedi" AYNI ŞEY DEĞİLDİR.
      stale: cat.stale,
      engineEfforts,
      models: cat.models.map((m) => ({
        id: m.id,
        label: m.label,
        // Bizim metnimiz SÖZLÜK ANAHTARI olarak gider (renderer çevirir); motorun
        // kendi metni ham geçer. İkisi bir arada → karışık dilli liste olurdu.
        descriptionKey: m.descriptionKey || null,
        description: m.description || null,
        defaultEffort: m.defaultEffort || null,
        efforts: modelCatalog.effortChoices(engineEfforts, m),
        usable: !!agentRunner.sanitizeModel(m.id),
      })),
    };
  }
  return out;
}

function aiProvidersPayload(settings) {
  const adapterReady = !!process.env.CREWPANE_ADAPTER_PORT;
  // ENG-OPENAI-COMPAT-01 — kullanıcının KENDİ ucu defterin SONUNA eklenir. Ayarlar
  // kapıdan geçmiş satırı saklar (agentSettings), o yüzden burada ek doğrulama YOK;
  // satır yoksa (null) liste bugünküyle BİREBİR aynıdır.
  const custom = (settings && settings.customProvider) || null;
  return providers.allProviders(custom).map((p) => ({
    id: p.id,
    label: p.label,
    settingsKey: p.settingsKey,
    needsShim: p.needsShim,
    // Kullanıcının eklediği satır mı (UI "düzenle/sil" sunar, ürünün satırlarına
    // sunmaz) + ADRESİ. Adres SIR DEĞİLDİR; anahtar ASLA buraya girmez.
    custom: p.custom === true,
    baseUrl: p.custom === true ? p.baseUrl : null,
    hasKey: !!(settings && settings.apiKeys && settings.apiKeys[p.settingsKey]),
    // ADP-595 — model listesi (ajan formundaki model seçicisi bunu çizer).
    // `usable`: bu model id'si spawn'da GERÇEKTEN uygulanabilir mi? agentRunner'ın
    // KENDİ biçim-whitelist'i (ADP-565 sanitizeModel) sorulur — UI kural KOPYALAMAZ.
    // Kanıtlanmış tuzak: whitelist '/' kabul etmiyor, dolayısıyla registry'deki
    // 'moonshotai/kimi-k2-instruct' gibi id'ler spawn'da SESSİZCE düşerdi (model yok →
    // withProvider da no-op → sağlayıcı hiç uygulanmaz). UI böyle bir modeli seçilemez
    // gösterir; kural agentRunner'da düzelirse (ADP-585/594 sahibi) burası kendiliğinden
    // doğruyu söyler.
    models: p.models.map((m) => ({
      id: m.id,
      label: m.label,
      usable: !!agentRunner.sanitizeModel(m.id),
    })),
    // ADP-595 — bu sağlayıcı ŞU AN koşturulabilir mi (durumdan türer, isimden değil):
    // shim gerektirmeyen sağlayıcı her zaman hazır; gerektiren yalnız adapter ayaktaysa.
    ready: p.needsShim ? adapterReady : true,
    adapterRequired: p.needsShim,
    adapterReady,
  }));
}

/**
 * SKL-B3 (K-8) — ÜRÜNÜN KENDİ API anahtarları (bugün: Gemini) Ayarlar'a nasıl görünür.
 *
 * 🔴 BU LİSTE `aiProvidersPayload` DEĞİLDİR ve onunla karıştırılmamalıdır:
 *   • aiProviders  = codex'in ALTINDAKİ sağlayıcılar (Groq/DeepSeek/Kimi) — bir PANE
 *                    açar, `-c model_provider` ile koşar.
 *   • appApiKeys   = ürünün KENDİ yaptığı API çağrıları (video araştırma skill'i).
 *                    Pane açmaz, motor değildir; yalnız bir anahtar taşır.
 * Gemini'yi sağlayıcı listesine koymak, kullanıcıya codex'i Gemini ile koşturabilecekmiş
 * gibi bir buton çizerdi (Gemini uç noktası OpenAI-Responses konuşmaz → 404). Ayrı liste
 * bu sessiz başarısızlığı YAPISAL olarak imkânsız kılar.
 *
 * SIR-GÜVENLİ: yalnız `hasKey` (varlık) + `source` (KAYNAK ADI) döner; anahtarın kendisi
 * renderer'a ASLA geçmez. `source` kullanıcıya "bu değer nereden geliyor" diyebilmek
 * içindir (Ayarlar mı, elle yazılmış keys.env mi) — K-8'in şeffaflık yarısı.
 *
 * İsim-bazlı dal YOK: kartlar `productCard: true` BEYAN eden kayıtlardan türer, yani
 * ikinci bir ürün anahtarı eklemek requireCredential.cjs'te tek satırdır.
 */
function appApiKeysPayload() {
  return Object.values(credentialGate.SERVICES)
    .filter((s) => s.productCard)
    .map((s) => {
      const r = credentialGate.resolveCredential(s.id, { rootDir: REPO_ROOT });
      return {
        id: s.id,
        label: s.label,
        settingsKey: s.settingsKey,
        settingsField: s.settingsField,
        keyLabel: s.keyLabel || null,
        keyUrl: s.keyUrl || null,
        feature: s.feature,
        hasKey: r.ok === true,
        source: r.ok ? r.source : null,
        // Doğrulama düğmesi yalnız GERÇEK bir uç nokta beyan eden kayıtta çizilir —
        // olmayan bir doğrulama vaat edilmez (ADP-749 içtihadı).
        canVerify: !!s.verify,
      };
    });
}

/**
 * SKL-B3 — "Doğrula": anahtarı GERÇEKTEN sağlayıcıya sorar (sessiz "kaydedildi"
 * rozetinin yerine geçen şey). Üç kural:
 *   1. Anahtar MAIN'de kalır: renderer ne gönderir ne alır — kapıdan çözülür.
 *   2. Anahtar BAŞLIKLA gider (`verify.header`), URL sorgusuna ASLA (sorgu dizesi
 *      proxy/erişim kayıtlarına düşer).
 *   3. Dönen metin sırdan ARINDIRILIR ve log satırı yalnız servis + kaynak + HTTP
 *      kodu taşır.
 */
async function verifyAppApiKey(service) {
  const spec = credentialGate.SERVICES[service];
  if (!spec || !spec.verify) return { ok: false, reason: 'unsupported' };
  const r = credentialGate.resolveCredential(spec.id, { rootDir: REPO_ROOT });
  if (!r.ok) return { ok: false, reason: 'no-key', message: r.message, settingsTarget: r.settingsTarget || null };
  // Sırrı dönen HİÇBİR metinde bırakma (sağlayıcı gövdesi bugün anahtarı yansıtmıyor
  // ama bu bir SÖZ değil; ikinci katman ucuz).
  const scrub = (t) => String(t == null ? '' : t).split(r.secret).join('«gizli»').slice(0, 300);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const headerValue = spec.verify.headerFormat
      ? `${spec.verify.headerFormat} ${r.secret}`
      : r.secret;
    const res = await fetch(spec.verify.url, {
      method: 'GET',
      headers: { [spec.verify.header]: headerValue },
      signal: ac.signal,
    });
    let count = null;
    let detail = '';
    try {
      const body = await res.json();
      const list = spec.verify.countPath ? body[spec.verify.countPath] : null;
      if (Array.isArray(list)) count = list.length;
      if (!res.ok) detail = scrub((body && body.error && body.error.message) || '');
    } catch {
      /* gövde JSON değil → yalnız HTTP kodu konuşur */
    }
    logLine(`appkey verify service=${spec.id} source=${r.source} http=${res.status}`);
    if (!res.ok) return { ok: false, reason: 'rejected', status: res.status, detail, source: r.source };
    return { ok: true, source: r.source, status: res.status, count };
  } catch (e) {
    // Ağ yok / zaman aşımı: "anahtar geçersiz" demek YALAN olurdu — ÖLÇEMEDİK.
    logLine(`appkey verify service=${spec.id} source=${r.source} ÖLÇEMEDİ`);
    return { ok: false, reason: 'unreachable', detail: scrub(e && e.message), source: r.source };
  } finally {
    clearTimeout(timer);
  }
}

function wireIpc() {
  // ── Sistem IPC Yüzeyi (Faz 3.5 — Sıra 1): clip, file, feedback, announce ────────
  registerSystemIpc({
    ipcMain,
    shell,
    clipboard,
    nativeImage,
    feedbackBridge,
    readFeedbackSeen,
    writeFeedbackSeen,
    readWorkspaceFile,
    writeWorkspaceFile,
    listWorkspaceDir,
    openFolderDialog,
    allowPaneRoot,
    readEditorState,
    writeEditorState,
    clipHistory,
    ptys,
    clipboardImageRoute,
    saveTempImage,
    announcements,
    agentSettings,
    announceStateForRenderer,
    runAnnounceCheck,
    pushAnnounceState,
    announceHiddenThisSession,
    getAnnounceState: () => announceState,
    logLine,
  });

  // ── Popout & Design IPC Yüzeyi (Faz 3.5 — Sıra 2) ───────────────────────────
  registerPopoutIpc({
    ipcMain,
    openPopoutWindow,
    closePopoutWindow,
    listPopoutPanes,
    popoutWindowFor,
    logLine,
  });

  registerDesignIpc({
    ipcMain,
    openDesignWindow,
    closeDesignWindow,
    designWindowAlive,
    listPanes,
    resolveInRoots,
    withinActiveRoots,
    displayPath,
    logLine,
  });

  registerSpritesIpc({
    ipcMain,
    localSprites,
    pkgMgr: require('./src/agents/avatarPackageManager.cjs'),
    logLine,
  });

  registerOfficeIpc({
    ipcMain,
    officePkg: require('./src/agents/officePackageManager.cjs'),
    readOfficeState,
    writeOfficeState,
    keepPanesAliveOnWindowClose,
    crashWatchdog,
    getAppWindow: () => appWindow,
    getAppBaseUrl: () => appBaseUrl,
    ptys,
    createAppWindow,
    logLine,
  });

  registerResourceIpc({
    ipcMain,
    resourceGovernor,
    agentSettings,
    ptys,
    agentRunner,
    resourceGovernorModule,
    killPaneExplicitAndCleanup,
    logLine,
  });

  registerUpdateIpc({
    ipcMain,
    updateStateForRenderer,
    runUpdateCheck,
    updateLicenseGateNow,
    getAutoUpdaterRef: () => autoUpdaterRef,
    getUpdateState: () => updateState,
    setUpdateState: (s) => { updateState = s; },
    pushUpdateState,
    updateCheck,
    shell,
    noteQuit,
    agentSettings,
    logLine,
  });

  // ── Services IPC Yüzeyi (Faz 3.5 — Sıra 3) ──────────────────────────────────
  registerWorktreeIpc({
    ipcMain,
    ptys,
    worktreeStore,
    crewpaneHome,
    projectRepos,
    agentWorkspaceRoot,
    agentSettings,
    mergeService,
    worktreeService,
    invalidateGitBranchCache,
    logLine,
  });

  registerBrowserIpc({
    ipcMain,
    runBrowserAction,
    browserGate,
    browserGuests,
    isOwnedGuest,
    guestOwners,
    setAppWindowGuest: (g) => { appWindowGuest = g; },
    getAppWindowGuest: () => appWindowGuest,
    agentGuests,
    lastUnownedGuest,
    logLine,
  });

  registerIntegIpc({
    ipcMain,
    supervisorFor,
    integrations,
    planDenial,
    ptys,
    mcpProcess,
    crewpaneHome,
    integrationAutostart,
    telemetryProvisioning,
    logLine,
  });

  registerSprintIpc({
    ipcMain,
    sprintStore,
    supervisorFor,
    resultRootMod,
    agentWorkspaceRoot,
    agentSettings,
    worktreeStore,
    crewpaneHome,
    activeWorktreePaths,
    ptys,
    evidencePathMod,
    REPO_ROOT,
    logLine,
  });

  // ── Memory IPC Yüzeyi (Faz 3.5 — Sıra 4) ───────────────────────────────────
  registerMemoryIpc({
    ipcMain,
    memoryGraph,
    getAgentWorkspaceRoot: () => agentWorkspaceRoot,
    memoryIndexer,
    memorySearcher,
    agentSettings,
    memoryEmbedder,
    REPO_ROOT,
    memoryEmbedInstall,
    memoryEmbedInstaller,
    memoryRecall,
    secretRedactor,
    ptys,
    agentRunner,
    memoryTaskBlock,
    currentSessionId,
    paneContextScope,
    engineMemoryScope,
    logLine,
  });

  // ── Hand IPC Yüzeyi (Faz 3.5 — Sıra 5) ─────────────────────────────────────
  registerHandIpc({
    ipcMain,
    screen,
    BrowserWindow,
    getHandOverlayWindows: () => (windowManager ? windowManager.handOverlayWindows : new Map()),
    getHandOverlayPrefs: () => (windowManager ? windowManager.handOverlayPrefs() : { overlay: {} }),
    handOverlayAnyAlive: () => handOverlayAnyAlive(),
    closeHandOverlayWindows: (why) => closeHandOverlayWindows(why),
    feedHandOverlay: (raw) => feedHandOverlay(raw),
    getWindowManager: () => windowManager,
    getHandControl: () => handControl,
    startHandControl: () => startHandControl(),
    stopHandControl: (why) => stopHandControl(why),
    handControlStatus: () => handControlStatus(),
    handControlLive: () => handControlLive(),
    finishPoseSampler: () => finishPoseSampler(),
    selectHandCamera: (sel) => selectHandCamera(sel),
    onHandDetectFrame,
    handDetectAlive,
    broadcastHandControlStatus,
    handCameraPolicy,
    handHardwareCameras,
    handCameraPreference,
    logLine,
  });

  // ── Sync IPC Yüzeyi (Faz 3.5 — Sıra 6) ─────────────────────────────────────
  registerSyncIpc({
    ipcMain,
    getSyncRuntime: () => syncRuntime,
    getSyncIpcSurface: () => syncIpcSurface,
  });

  // ── Mobile IPC Yüzeyi (Faz 3.5 — Sıra 6) ───────────────────────────────────
  registerMobileIpc({
    ipcMain,
    mobilePending,
    mobileCommandPending,
    emitMobileEvent: (e) => emitMobileEvent(e),
    getMobileGateway: () => mobileGateway,
    mobileDeviceStore,
    mobilePlanDenial: (opts) => mobilePlanDenial(opts),
    startMobile: () => startMobile(),
    getMobileGatewayLastFailure: () => mobileGatewayLastFailure,
    mobileStartFailure: (ctx) => mobileStartFailure(ctx),
    mobileKillSwitch: () => mobileKillSwitch(),
    mobileProbe,
  });

  // SKL-B3 — Ayarlar'daki "Doğrula" düğmesinin ucu. Renderer yalnız SERVİS ADI verir;
  // anahtar bu sınırı hiçbir yönde geçmez.
  ipcMain.handle('appkey:verify', async (_event, service) => verifyAppApiKey(String(service || '')));

  // ── PTY Terminal IPC Yüzeyi (Faz 3.5 — Sıra 9) ─────────────────────────────
  registerPtyIpc({
    ipcMain,
    BrowserWindow,
    requireSeatOrThrow,
    dedupeSpawnForAgent,
    planDenial,
    ptys,
    resourceGovernor,
    engineDelegation,
    prepareTaskIsolation,
    preflightModelGate,
    spawnPty,
    analyticsEngineOf,
    telemetryBump,
    workspaceOnboarding,
    enforcePaneBudget,
    spendGuard,
    leaderComposer,
    probeTranscriptContains,
    transcriptProbe,
    currentSessionId,
    secretRedactor,
    mobileTranscript,
    tokenUsage,
    paneTokenBudget,
    getWorkspaceRoot: () => agentWorkspaceRoot,
    paneBudgetStore,
    paneDispatchDecisionFor,
    leaderRefreshTick,
    leaderRefreshViewFor,
    logDispatchDecision,
    refreshPaneSession,
    dispatchStore,
    getAppWindow: () => appWindow,
    popoutPaneIdForWindow,
    listPanes,
    agentRunner,
    modelDetect,
    paneAskRuntime,
    paneSessionAnchor,
    sessionAnchor,
    ptyResizeGate,
    killPaneExplicitAndCleanup,
    logLine,
  });

  // ADP-028 — attach to an EXISTING pane instead of spawning a new one. Returns
  // the rolling replay buffer + the current cumulative byte `seq` so the
  // attaching <Terminal> can repaint recent scrollback and then dedupe any live
  // `pty:data` it already received (events with seq <= the returned seq). The
  // pane keeps streaming via the normal `pty:data` broadcast — attach does not
  // re-route anything, it just hands over the backlog. Unknown paneId → ok:false.
  // ADP-734 Kapı 2 — "N pane kurtarılabilir" teklifini UYGULA. Teklif diskte
  // (live-panes.recoverable.json) durduğu için pencere kapanıp açılsa da geçerlidir.
  ipcMain.handle('panes:restoreRecoverable', (event) =>
    acceptRecoverablePanes(BrowserWindow.fromWebContents(event.sender)));

  // ── Voice & Jarvis IPC Yüzeyi (Faz 3.5 — Sıra 10) ─────────────────────────
  registerVoiceIpc({
    ipcMain,
    app,
    BrowserWindow,
    getAppWindow: () => appWindow,
    openJarvisWidgetWindow,
    closeJarvisWidgetWindow,
    jarvisWidgetAlive,
    windowManager,
    jarvisWidget,
    broadcastJarvisWidget,
    jarvisWidgetPayload,
    moveJarvisWidget,
    showAppFromJarvisWidget,
    agentSettings,
    jarvisVoice,
    REPO_ROOT,
    appI18n,
    grokVoice,
    inputSim,
    screenCaptureMod,
    instancePaths,
    getJarvisConv: () => jarvisConv,
    logLine,
  });

  // ADP-136 — auto-switch the operator's tmux window to the team Jarvis is about to
  // delegate to (so the work is SEEN starting). Best-effort: tmux/session/window
  // absent → typed no-op result, never throws. Pure mapping in tmuxWindows.cjs.
  ipcMain.handle('tmux:selectWindow', (_event, department) => {
    try {
      const res = tmuxWindows.selectWindowForDepartment(department);
      logLine(`tmux:selectWindow dept=${department ?? '-'} ok=${res.ok} target=${res.target ?? '-'} reason=${res.reason ?? '-'}`);
      return res;
    } catch (err) {
      return { ok: false, reason: 'error', error: String((err && err.message) || err) };
    }
  });



  // ── Agent X IPC Yüzeyi (Faz 3.5 — Sıra 8) ──────────────────────────────────
  registerAgentxIpc({
    ipcMain,
    BrowserWindow,
    screen,
    agentxDeliverer,
    agentxBeamMod,
    getAppWindow: () => appWindow,
    jarvisWidgetAlive,
    logLine,
  });


  // ADP-712 — PANE GÖRÜNÜM DURUMU (okunabilir mod). Aynı pane'in iki görünümü
  // (ızgara hücresi + ayrı pencere) TEK tercihi paylaşsın diye durum main'de
  // yaşar ve her değişim TÜM pencerelere yayınlanır ("pty tek, iki görünüm").
  ipcMain.handle('paneView:get', (_event, paneId) => paneViewState.getPaneView(paneId));
  ipcMain.handle('paneView:set', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const res = paneViewState.setPaneView(p.paneId, p);
    if (res.ok && res.changed) broadcastPaneView(res.paneId, res.readable);
    return res;
  });

  // ADP-786 — GÖNDERİLMEMİŞ PROMPT TASLAĞI. Aynı gerekçe, aynı desen: taslak
  // renderer'da yaşarsa pencere (ayrı renderer) ve mod (koşullu mount) değişimi
  // onu SİLER — kullanıcının yazdığı metin veri kaybına dönüşür.
  ipcMain.handle('paneDraft:get', (_event, paneId) => paneDraft.getPaneDraft(paneId));
  ipcMain.handle('paneDraft:set', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const res = paneDraft.setPaneDraft(p.paneId, p.text);
    if (res.ok && res.changed) broadcastPaneDraft(res.paneId, res.text);
    return res;
  });

  // ── Agent X Draft IPC Yüzeyi (Faz 3.5 — Sıra 8) ────────────────────────────
  registerAgentxDraftIpc({
    ipcMain,
    agentxDraft,
    broadcastAgentxDraft,
    broadcastAgentxDraftConfirmed,
  });

  // ADP-035 — multimodal prompt image attach. The renderer (sandboxed, no fs)
  // sends an image blob's bytes; main writes it to a temp file and returns the
  // PATH. The prompt box injects that path into the prompt → the CLI opens it
  // (UX-UI-V2 §5: path injection, NOT base64 to an API). Bounded (size +
  // image-only). WIN-IMG-01: ömür OTURUM boyudur, TTL yok.
  ipcMain.handle('image:saveTemp', (_event, payload) => saveTempImage(payload));

  // WIN-IMG-01 — SESSİZ BAŞARISIZLIK YASAĞI. Gönderimden HEMEN ÖNCE "bu görseller
  // hâlâ diskte mi?" sorusunu main cevaplar; eksikse kullanıcı GÖRÜR (bugün ajan
  // "erişemiyorum" deyip kendi yorumunu yapıyordu, kullanıcı sebebi bilmiyordu).
  // Yalnız KENDİ görsel kökümüzdeki yollara bakar → renderer'a genel bir dosya
  // varlık-oracle'ı AÇILMAZ (kökün dışı `foreign` olarak döner, "eksik" değil).
  ipcMain.handle('image:verify', (_event, paths) => imageStore.verify(Array.isArray(paths) ? paths : []));

  // BOARD-IMG-3 — GÖREV KARTI EKLERİ. Renderer baytları (sürükle-bırak / ⌘V) ya da
  // bir dosya YOLUNU (native drop, ADP-143 fileDropApi) verir; main doğrular, diske
  // içerik-adresli yazar ve SATIRIN ALANLARINI döndürür. INSERT'i renderer kendi
  // supabase istemcisiyle yapar (kimlik + schema orada zaten çözülü).
  ipcMain.handle('attachment:ingest', (_event, payload) => ingestTaskAttachment(payload));
  // Tam çözünürlük OKUMA: renderer'a fs açılmaz, data-URI döner (localSprites deseni).
  // Baytlar bu cihazda yoksa dürüst `{ok:false, reason:'missing'}` → UI "kaynak: <cihaz>"
  // mesajını yazabilsin (sessizce boş kare göstermek yasak).
  ipcMain.handle('attachment:read', (_event, relPath) => attachmentStore().readDataUrl(relPath));
  ipcMain.handle('attachment:hasBytes', (_event, relPath) => ({ ok: true, present: attachmentStore().hasBytes(relPath) }));
  // Baytları diskten sil — SATIRI silmez (o mantıksaldır, renderer `deleted_at` yazar).
  // İki adım bilerek ayrı: "karttan kaldır" ile "diskten de sil" farklı kararlardır.
  ipcMain.handle('attachment:removeBytes', (_event, relPath) => attachmentStore().removeBytes(relPath));

  // ── Skills IPC Yüzeyi (Faz 3.5 — Sıra 8) ───────────────────────────────────
  registerSkillsIpc({
    ipcMain,
    app,
    skillCenter,
    skillEngineSync,
    skillApprove,
    skillAuthor,
    skillVersions,
    skillShare,
    builtinSkills,
    skillGuard,
    skillEngineView,
    getWorkspaceRoot: () => agentWorkspaceRoot,
    getBoundAccount: () => boundAccount,
    syncSkillEngineViews,
    logLine,
  });

  // ── SEARCH-2 — GENEL ARAMA (rapor gövdesi · hafıza · görev · ajan oturumları) ──
  // Bu uçlar ADP-871'in `memoryIndex:search`ini DEĞİŞTİRMEZ: o hibrit (anlam+kelime)
  // ve yalnız hafızaya bakar; bu salt kelime ama DÖRT kaynağa bakar. SEARCH-3'te
  // ikisi "AI'ya sor" sekmesinde buluşur.
  ipcMain.handle('searchIndex:query', (_evt, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {};
      return searchIndexer().query({
        text: String(p.text || ''),
        types: Array.isArray(p.types) && p.types.length ? p.types.map(String).slice(0, 12) : null,
        agent: p.agent ? String(p.agent) : null,
        perType: Number.isFinite(p.perType) ? Math.max(1, Math.min(20, p.perType)) : 5,
      });
    } catch (err) {
      logLine(`searchIndex:query failed: ${err.message}`);
      return { ok: false, reason: err.message, groups: {}, total: 0 };
    }
  });
  ipcMain.handle('searchIndex:status', () => {
    try {
      return searchIndexer().status();
    } catch (err) {
      return { running: false, phase: 'error', reason: err.message };
    }
  });
  ipcMain.handle('searchIndex:reindex', () => {
    try {
      return searchIndexer().start();
    } catch (err) {
      logLine(`searchIndex:reindex failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });
  // Görev anlık görüntüsü RENDERER'DAN gelir: işçi Supabase'e bağlanmaz, main de
  // board için yeni bir ağ yolu açmaz (kartlar zaten renderer'ın belleğinde).
  ipcMain.handle('searchIndex:syncTasks', (_evt, rows) => {
    try {
      return searchIndexer().syncTasks(Array.isArray(rows) ? rows.slice(0, 20000) : []);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });
  // OPT-OUT: kapatmak SİLER (bir sonraki tur oturum belgelerini indeksten kaldırır).
  ipcMain.handle('searchIndex:setSessionsEnabled', (_evt, enabled) => {
    try {
      const v = !!enabled;
      agentSettings.writeSettings({ memorySearch: { sessionsIndexed: v } });
      return searchIndexer().setSessionsEnabled(v);
    } catch (err) {
      logLine(`searchIndex:setSessionsEnabled failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });

  // (ADP-440 — screenshot:* ve tray:* IPC yüzeyleri kaldırıldı; AgentShot ayrı ürün.)

  // ADP-082 (ADR-006) — workspace file bridge for the embedded code editor.
  // Root-guarded + size-capped; the sandboxed renderer reads/writes/lists ONLY
  // inside the workspace root (path-traversal/symlink escapes rejected above).
  // ADP-538 — worker-completion notify: delegasyon follow-loop'u (renderer) buraya
  // emit eder; satır resume-daemon'la AYNI log dosyasına düşer (resolveResumeNotifyPath:
  // dev → docs/.agent-notifications, paketli → instance dir, env CREWPANE_RESUME_NOTIFY
  // override — e2e bu dikişle deterministik dosyaya yönlendirir). Liderlerin Monitor
  // tail'i bu satırlarla OTOMATİK tetiklenir; in-app delegasyon bu satırları hiç
  // yazmıyordu (yalnız eski tmux watch-agent-result yazardı) — ADP-538'in kök fix'i.
  // ADP-667 — HER İKİ yazar (renderer follow-loop'u + main supervisor'ı) buradan
  // geçer: aynı bitiş iki kez yazılmaz, aynı pencerede biten işler TEK satırda
  // toplanır. Dönüş `duplicate` çağırana "bunu zaten biri bildirdi" der.
  ipcMain.handle('notify:workerEvent', (_event, evt) =>
    supervisorFor('notify-log').run(
      'workerEvent',
      // ADP-545 — yol departman-farkındalıklı: chatflow/education olayları kendi
      // takım dosyalarına, crewpane (ve departmansız) olaylar workspace'in
      // crewpane/docs hedefine (kurulumda liderlerin tail'lediği dosyalar).
      // ADP-586 — notify dosyası (docs/.agent-notifications) REPO'ya commit'lenir:
      // bir FAIL detayına düşen jeton kalıcı olur → olay maskeden geçirilerek yazılır.
      () => {
        const res = notifyGate().admit(evt || {});
        return { ok: res.accepted, duplicate: res.duplicate === true };
      },
      { ok: false },
    ));

  // ADP-206 — editor code-intelligence: git diff (committed vs working) + workspace file
  // list (⌘P) + content grep (⌘⇧F). Read-only `git` against the configured workspace root.
  // TASK-MQTIX5XW2HFST — confine the path to an active root (parity with search), then let
  // codeIntel narrow to the file's ENCLOSING git repo: agentWorkspaceRoot is the non-git multi-
  // project parent, so diffing against it returned empty (no red/green). Pass the absolute path.
  ipcMain.handle('git:diff', (_event, filePath) => {
    const abs = resolveInRoots(filePath);
    if (!abs) return { ok: false, reason: 'path-denied' };
    return codeIntel.gitDiffFile(agentWorkspaceRoot, abs);
  });
  // ADP-402 — pane header'ındaki git-branch rozeti: pane cwd'si → saran repo'nun
  // branch adı. Subprocess YOK (.git/HEAD dosya okuması); renderer 1.5s pane
  // poll'una bindiği için cwd başına kısa TTL cache. Root-guard: cwd aktif
  // root'ların dışındaysa (örn. HOME'da açılmış shell) reddedilir → rozet çizilmez.
  // B-02 — `opts.force` TTL'i atlar (ANINDA senkron: görev değişimi, attach, merge
  // sonrası). Zorlama YALNIZ olay başına gelir; poll yolu force GÖNDERMEZ, yoksa
  // her 1.5 sn'de her pane için dosya okuması yapılırdı (ADP-284 ihlali).
  ipcMain.handle('git:branch', (_event, cwd, opts) => {
    const abs = resolveInRoots(cwd);
    if (!abs) return { ok: false, reason: 'path-denied' };
    const force = opts && opts.force === true;
    const hit = gitBranchCache.get(abs);
    if (!force && hit && Date.now() - hit.at < GIT_BRANCH_TTL_MS) return hit.value;
    const value = { ok: true, branch: readGitBranch(abs) };
    gitBranchCache.set(abs, { at: Date.now(), value });
    return value;
  });
  // TASK-MQTIVZSDYPNRH — search scopes to the editor's ACTIVE workspace (2nd arg), not the
  // global root. codeIntel returns ABSOLUTE paths; we confine them to the active-root
  // sandbox and rebase to the renderer's display form (workspace-relative or absolute) so
  // a click opens the file through the SAME fileApi guard.
  ipcMain.handle('workspace:listFiles', async (_event, root) => {
    const base = resolveSearchRoot(root);
    if (!base) return { ok: false, reason: 'workspace_not_configured' }; // ADP-232-C
    const r = await codeIntel.listWorkspaceFiles(base);
    if (!r.ok) return r;
    return { ...r, files: r.files.filter(withinActiveRoots).map(displayPath) };
  });
  ipcMain.handle('workspace:grep', async (_event, payload) => {
    const { query, root } = payload && typeof payload === 'object' ? payload : { query: payload, root: undefined };
    const base = resolveSearchRoot(root);
    if (!base) return { ok: false, reason: 'workspace_not_configured' }; // ADP-232-C
    const r = await codeIntel.grepWorkspace(base, query);
    if (!r.ok) return r;
    const hits = r.hits.filter((h) => withinActiveRoots(h.file)).map((h) => ({ ...h, file: displayPath(h.file) }));
    return { ...r, hits };
  });

  // ── Delegation Queue & Supervisor IPC Yüzeyi (Faz 3.5 — Sıra 8) ────────────
  registerDelegationIpc({
    ipcMain,
    delegationQueueStore,
    delegationSupervisorStore,
    resumeQueueStore,
    queueBoard,
    evidencePathMod,
    supervisorFor,
    ensureDelegationSupervisor,
    scheduleSupervisorSweep,
    supervisorPending,
    supervisorFingerprint,
    ptys,
    crewpaneHome,
    getWorkspaceRoot: () => agentWorkspaceRoot,
    agentSettings,
    REPO_ROOT,
    activeWorktreePaths,
    logLine,
  });


  // ADP-203 — user Settings (~/.crewpane/settings.json). The renderer Settings panel
  // reads/writes the workspace root, OpenAI key, push-to-talk key, wake-model path.
  // SECURITY: `settings:get` NEVER returns secret values — only a `hasOpenAiKey` flag —
  // so a compromised renderer cannot exfiltrate the key (same discipline as jarvis:config).
  // ADP-844 — ofis bildirimlerinin ekran-dışı TEK yüzeyi mobil uygulamadır
  // (mobileGateway + /m/stream); main hiçbir dış mesajlaşma servisine bağlanmaz.

  // ADP-335 — bildirim merkezi bu ikisini kullanır: mevcut hataları oku + log'u aç (tıklama).
  ipcMain.handle('module:faults', () => ({ ok: true, faults: moduleFaults.slice(-20) }));

  // ADP-901 — RENDERER tarafındaki bir yüzey degrade oldu (ofis tuvali GL bağlamını
  // kaybetti, sahne çizmeyi bıraktı…). ADP-335'in sınırı yalnız MAIN'i kapsıyordu;
  // Eren'in "ofis bembeyaz" vakasında uygulamanın o günkü log'unda TEK BİR İZ yoktu.
  // Renderer'ın gönderdiği alanlar SANİTİZE edilir (log'a düşen her şey redaksiyondan
  // geçer) ve `module` sabit 'renderer' kalır — renderer main'in modül adını taklit edemesin.
  // OBS-02 — RENDERER YÜZEYİ ARTIK KÜRESEL. ADP-901 bu kanalı açtı ama yalnız birkaç
  // `catch` bloğundan çağrılıyordu; yakalanmamış bir renderer hatası (beyaz ekran)
  // hiçbir yere düşmüyordu. `src/app/components/GlobalErrorReporter.tsx` artık
  // `window.onerror` + `unhandledrejection`'ı buraya bağlıyor — yeni bir IPC kanalı
  // AÇILMADI, var olan kanal beslendi (paralel sistem kurma kuralı).
  ipcMain.handle('module:reportRenderer', (_event, payload) => {
    const f = payload && typeof payload === 'object' ? payload : {};
    const clip = (v, n) => (v == null ? '' : String(v).slice(0, n));
    // `level` renderer'dan gelebilir ama YALNIZ beyaz-listedeki değerler kabul edilir
    // (renderer 'fatal' iddia edip alarmı kendi başına tetikleyemesin).
    // HATA-16 — küme ÜÇE çıktı: 'info' (yüzey kendini onardı; zilde kalır, toast
    // çıkmaz) · 'warning' (ayakta ama ters giden bir şey var) · 'error' (VARSAYILAN).
    // Beyaz liste hâlâ KAPALI: bilinmeyen değer sessizce 'error'a düşer — bir arızayı
    // sessizleştirmek, bir başarıyı kırmızı göstermekten pahalıdır.
    const level = f.level === 'warning' || f.level === 'info' ? f.level : 'error';
    // SEN-F1 — KURTARMA AŞAMASI BAĞLAMI. Bunlar Sentry'de ETİKET olur, o yüzden
    // `level` ile aynı sertlikte: KAPALI KÜME. Renderer serbest etiket üretip
    // hata takibinin kardinalitesini patlatamaz (ve etiketle veri sızdıramaz).
    // HATA-06 — merdivene iki KABUK basamağı eklendi (reload-renderer,
    // recreate-window). Küme HÂLÂ KAPALI: renderer serbest etiket üretemez.
    const STAGES = new Set([
      'initial', 'reinit', 'recreate-canvas', 'reload-renderer', 'recreate-window', 'static',
    ]);
    const RENDERERS = new Set(['webgl', 'canvas', 'none']);
    const stage = STAGES.has(f.stage) ? f.stage : null;
    const renderer = RENDERERS.has(f.renderer) ? f.renderer : null;
    const attempt = Number.isFinite(f.attempt) ? Math.max(0, Math.min(99, Math.trunc(f.attempt))) : null;
    reportModuleFault({
      module: 'renderer',
      label: clip(f.label, 60) || 'ui',
      message: clip(f.message, 400) || 'bilinmeyen hata',
      location: clip(f.location, 200) || null,
      stopped: !!f.stopped,
      level,
      at: Date.now(),
      ...(stage ? { stage } : {}),
      ...(renderer ? { renderer } : {}),
      ...(attempt != null ? { attempt } : {}),
    }, { stack: clip(f.stack, 4000) || undefined });
    return { ok: true };
  });

  /**
   * OBS-01 — RENDERER YÜZEYİNİN TEK ANALİTİK KAPISI ("hangi panel kullanılıyor").
   *
   * Neden yeni bir kanal: panel/sekme kullanımı YALNIZ renderer'ın bildiği bir
   * olgudur ve main'de karşılığı olan bir sinyal yoktur (huninin üç adımı ve plan
   * redleri aksine ZATEN main'deydi — onlar için yeni hiçbir şey açılmadı). Kanal
   * `module:reportRenderer`ın analitik ikizidir ve aynı sertlikte:
   *   • olay adı `analyticsSchema` kayıt defterinde OLMAK ZORUNDA,
   *   • her özellik değeri kapalı kümeden geçer (serbest metin yok),
   *   • ortak damga (sürüm/platform/katman) renderer'dan DEĞİL main'den gelir —
   *     renderer kendi sürümünü/katmanını iddia edemez.
   * Yani ele geçirilmiş bir renderer bile bu kanaldan içerik SIZDIRAMAZ: gövde
   * şemanın ürettiği kadardır.
   */
  ipcMain.handle('analytics:track', (_event, payload) => {
    try {
      const p = payload && typeof payload === 'object' ? payload : {};
      const name = typeof p.event === 'string' ? p.event : '';
      // Renderer yalnız KENDİ yüzeyinin olaylarını yazabilir; huni/plan olaylarını
      // main üretir ve renderer onları taklit edemez.
      // HATA-06 — İKİNCİ İZİNLİ OLAY: kurtarma merdiveninin hangi basamağının
      // GERÇEKTEN kurtardığı. Bu YALNIZ renderer'ın bildiği bir olgudur (basamağın
      // kare bastığı ölçümü sayfanın içinde yapılır) ve main'de karşılığı yoktur.
      // Kapı aynı sertlikte: iki alan da KAPALI KÜMEDEN geçer (analyticsSchema).
      if (name === 'canvas_recovery_step') {
        const res = analyticsNow().track('canvas_recovery_step', {
          stage: analyticsSchema.coerce(
            analyticsSchema.EVENTS.canvas_recovery_step.stage, String(p.stage || ''),
          ) || 'other',
          outcome: analyticsSchema.coerce(
            analyticsSchema.EVENTS.canvas_recovery_step.outcome, String(p.outcome || ''),
          ) || 'other',
        });
        return { ok: !!res.sent, reason: res.reason };
      }
      // SEC-W3-B1b-S — SUNUCU KAYDETMEYİ ABONELİK YÜZÜNDEN REDDETTİ. Olgu
      // YALNIZ renderer'da bilinir: ret, supabase-js çağrısının dönüşünde doğar
      // ve main'de karşılığı yoktur (bulut senkronun kendi yolu AYRIDIR ve
      // `syncQueue` üzerinden ölçülür). 19.09'da bu olay olmadığı için PROD'da
      // 14 668 ret'e karşılık 0 telemetri satırı vardı. Tek alan, kapalı küme.
      if (name === 'entitlement_write_blocked') {
        const surface = analyticsSchema.coerce(
          analyticsSchema.EVENTS.entitlement_write_blocked.surface, String(p.surface || ''),
        ) || 'other';
        const res = analyticsNow().track('entitlement_write_blocked', { surface });
        return { ok: !!res.sent, reason: res.reason };
      }
      // TOUR-02-A — GİRİŞ TURU ÖLÇÜMÜ. Bu iki olayın olgusu YALNIZ renderer'da
      // bilinir (bir günlük maddesi hangi anda tamamlandı, panel açık mı) ve
      // main'de karşılığı yoktur — canvas_recovery_step ile aynı gerekçe. Kapı
      // aynı sertlikte: her alan analyticsSchema'nın KAPALI kümesinden geçer,
      // geçmeyen düşer. Prompt/görev metni taşıyabilecek bir alan YOK.
      if (name === 'onb.quest.done') {
        const quest = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.quest.done'].quest, String(p.quest || ''),
        );
        if (!quest) return { ok: false, reason: 'bad-quest' };
        const res = analyticsNow().track('onb.quest.done', {
          quest,
          seconds: analyticsSchema.coerce(analyticsSchema.EVENTS['onb.quest.done'].seconds, p.seconds) ?? 0,
          required: p.required === true,
        });
        return { ok: !!res.sent, reason: res.reason };
      }
      if (name === 'onb.quest.panel') {
        const action = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.quest.panel'].action, String(p.action || ''),
        );
        if (!action) return { ok: false, reason: 'bad-action' };
        const res = analyticsNow().track('onb.quest.panel', { action });
        return { ok: !!res.sent, reason: res.reason };
      }
      // TOUR-P1-01 — "GÖSTER"E BASILDI VE NE OLDU. Kartın kök nedeni ölü bir
      // düğmeydi; `outcome:'none'` panoda görülmeden hiçbir ölü düğme
      // ölçülemez. İki alan da kapalı küme — geçmeyen olay HİÇ gönderilmez.
      if (name === 'onb.quest.show') {
        const quest = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.quest.show'].quest, String(p.quest || ''),
        );
        if (!quest) return { ok: false, reason: 'bad-quest' };
        const outcome = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.quest.show'].outcome, String(p.outcome || ''),
        );
        if (!outcome) return { ok: false, reason: 'bad-outcome' };
        const res = analyticsNow().track('onb.quest.show', { quest, outcome });
        return { ok: !!res.sent, reason: res.reason };
      }
      // TOUR-P1-01 — GERİYE DÖNÜK TAMAMLAMA koştu. Üç olgu `true/false/null`
      // dizgisidir: "ölçülemedi" ile "yok" panoda AYRI görünmeli, yoksa ölçüm
      // arızası kullanıcı davranışı gibi okunur.
      if (name === 'onb.quest.backfill') {
        const spec = analyticsSchema.EVENTS['onb.quest.backfill'];
        const emitted = analyticsSchema.coerce(spec.emitted, p.emitted);
        if (emitted === null || emitted === undefined) return { ok: false, reason: 'bad-emitted' };
        const engine = analyticsSchema.coerce(spec.engine, String(p.engine || ''));
        const office = analyticsSchema.coerce(spec.office, String(p.office || ''));
        const board = analyticsSchema.coerce(spec.board, String(p.board || ''));
        if (!engine || !office || !board) return { ok: false, reason: 'bad-fact' };
        const res = analyticsNow().track('onb.quest.backfill', { emitted, engine, office, board });
        return { ok: !!res.sent, reason: res.reason };
      }
      // TOUR-P1-01 — Rehber'in ipucu düğmesi ve sonucu (`onb.quest.show` ikizi;
      // iki yüzey aynı yorumlayıcıyı kullanıyor, ölçümü de aynı dilde konuşur).
      if (name === 'onb.tour.hintAction') {
        const spec = analyticsSchema.EVENTS['onb.tour.hintAction'];
        const kind = analyticsSchema.coerce(spec.kind, String(p.kind || ''));
        if (!kind) return { ok: false, reason: 'bad-kind' };
        const outcome = analyticsSchema.coerce(spec.outcome, String(p.outcome || ''));
        if (!outcome) return { ok: false, reason: 'bad-outcome' };
        const res = analyticsNow().track('onb.tour.hintAction', { kind, outcome });
        return { ok: !!res.sent, reason: res.reason };
      }
      // TOUR-02-Q-F3 — REHBERİN KAPATILMASI (sözleşme §6 dördüncü satırı).
      // Aynı gerekçe: "kullanıcı Rehber'i hangi adımda terk etti" YALNIZ
      // renderer'ın bildiği bir olgudur. Kapı aynı sertlikte — üç alan da
      // kapalı kümeden/sayıdan geçer, geçmeyen düşer; `step` ya da `via`
      // tanınmazsa olay HİÇ gönderilmez (yanlış adıma yazılmış bir kopma
      // noktası, hiç yazılmamış olandan daha kötüdür).
      if (name === 'onb.guide.dismissed') {
        const step = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.guide.dismissed'].step, String(p.step || ''),
        );
        if (!step) return { ok: false, reason: 'bad-step' };
        const via = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.guide.dismissed'].via, String(p.via || ''),
        );
        if (!via) return { ok: false, reason: 'bad-via' };
        const res = analyticsNow().track('onb.guide.dismissed', {
          step,
          via,
          seconds: analyticsSchema.coerce(
            analyticsSchema.EVENTS['onb.guide.dismissed'].seconds, p.seconds,
          ) ?? 0,
        });
        return { ok: !!res.sent, reason: res.reason };
      }
      // ─── TOUR-02-Q-F5 — §6'nın KALAN OLAYLARI ────────────────────────────
      // Bu beş olay renderer'da DOĞRU üretiliyordu ama burada dalları YOKTU:
      // handler tanımadığı adı `not-allowed` ile düşürür, yani sözleşme §6'nın
      // BİRİNCİ ("nerede kopuyorlar") ve ÜÇÜNCÜ ("hangi ipucu işe yarıyor")
      // satırları hiç ölçülmüyordu — panoda bu, "kullanıcı hiç yapmadı" gibi
      // okunur. Sıfır satır kusurun kendisini gizler.
      //
      // Yeni kanal AÇILMADI, yeni şema YAZILMADI: hepsi `analyticsSchema`'da
      // zaten tanımlıydı. Kapı komşularla AYNI sertlikte — her alan kapalı
      // kümeden/sayıdan geçer, tanınmayan bir kapalı-küme değeri olayı HİÇ
      // göndertmez (yanlış adıma/ipucuna yazılmış bir ölçüm, hiç yazılmamış
      // olandan daha kötüdür). Serbest metin alanı YOK.
      if (name === 'onb.tour.step') {
        const step = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tour.step'].step, String(p.step || ''),
        );
        if (!step) return { ok: false, reason: 'bad-step' };
        const phase = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tour.step'].phase, String(p.phase || ''),
        );
        if (!phase) return { ok: false, reason: 'bad-phase' };
        const mode = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tour.step'].mode, String(p.mode || ''),
        );
        if (!mode) return { ok: false, reason: 'bad-mode' };
        const res = analyticsNow().track('onb.tour.step', {
          step,
          phase,
          mode,
          seconds: analyticsSchema.coerce(
            analyticsSchema.EVENTS['onb.tour.step'].seconds, p.seconds,
          ) ?? 0,
        });
        return { ok: !!res.sent, reason: res.reason };
      }
      if (name === 'onb.tip.shown') {
        const tip = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tip.shown'].tip, String(p.tip || ''),
        );
        if (!tip) return { ok: false, reason: 'bad-tip' };
        const res = analyticsNow().track('onb.tip.shown', { tip });
        return { ok: !!res.sent, reason: res.reason };
      }
      if (name === 'onb.tip.dismissed') {
        const tip = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tip.dismissed'].tip, String(p.tip || ''),
        );
        if (!tip) return { ok: false, reason: 'bad-tip' };
        const action = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.tip.dismissed'].action, String(p.action || ''),
        );
        if (!action) return { ok: false, reason: 'bad-action' };
        const res = analyticsNow().track('onb.tip.dismissed', { tip, action });
        return { ok: !!res.sent, reason: res.reason };
      }
      if (name === 'onb.topic.started') {
        const topic = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.topic.started'].topic, String(p.topic || ''),
        );
        if (!topic) return { ok: false, reason: 'bad-topic' };
        const from = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.topic.started'].from, String(p.from || ''),
        );
        if (!from) return { ok: false, reason: 'bad-from' };
        const res = analyticsNow().track('onb.topic.started', { topic, from });
        return { ok: !!res.sent, reason: res.reason };
      }
      if (name === 'onb.topic.done') {
        const topic = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.topic.done'].topic, String(p.topic || ''),
        );
        if (!topic) return { ok: false, reason: 'bad-topic' };
        const reason = analyticsSchema.coerce(
          analyticsSchema.EVENTS['onb.topic.done'].reason, String(p.reason || ''),
        );
        if (!reason) return { ok: false, reason: 'bad-reason' };
        const res = analyticsNow().track('onb.topic.done', {
          topic,
          reason,
          steps: analyticsSchema.coerce(
            analyticsSchema.EVENTS['onb.topic.done'].steps, p.steps,
          ) ?? 0,
          clean: p.clean === true,
        });
        return { ok: !!res.sent, reason: res.reason };
      }
      if (name !== 'panel_view') return { ok: false, reason: 'not-allowed' };
      const panel = analyticsSchema.panelOf(p.panel);
      const res = analyticsNow().track('panel_view', {
        panel,
        first_time: analyticsFirstTime(`panel:${panel}`),
      });
      return { ok: !!res.sent, reason: res.reason };
    } catch {
      return { ok: false, reason: 'internal' };
    }
  });
  // ─── TOUR-02-A — "İlk 10 Dakika" görev günlüğünün KALICILIĞI ───────────────
  // Main DUMB IO'dur: iki HAM kaydı okur, birleşmiş kaydı iki yüzeye yazar.
  // LWW birleştirme renderer'da (src/app/lib/onboardingQuests.ts mergeProgress),
  // TEK yerde ve birim testli — ikinci bir birleştirme kopyası "iki gerçek"
  // sınıfını bedavaya açardı. Hiçbir yol fırlatmaz: bir ilerleme kaydı ürünü
  // düşüremez.
  ipcMain.handle('onboarding:load', () => {
    try { return { ok: true, ...onboardingStore.load() }; }
    catch { return { ok: false, local: null, portable: null }; }
  });
  ipcMain.handle('onboarding:save', (_event, progress) => {
    try { return onboardingStore.save(progress); }
    catch (err) { return { ok: false, error: String((err && err.code) || 'internal') }; }
  });
  // TOUR-02-C — bağlamsal ipuçlarının kaydı (hangi ipucu gösterildi, hangi tetik
  // kaç kez görüldü). AYNI sözleşme: main DUMB IO'dur, iki HAM kaydı verir ve
  // birleşmiş kaydı yazar; LWW renderer'da (`onboardingTips.mergeTips`, birim
  // testli). Gövde yalnız kapalı küme id'leri, sayaçlar ve damgalardır.
  ipcMain.handle('onboarding:tips:load', () => {
    try { return { ok: true, ...onboardingStore.loadTips() }; }
    catch { return { ok: false, local: null, portable: null }; }
  });
  ipcMain.handle('onboarding:tips:save', (_event, tips) => {
    try { return onboardingStore.saveTips(tips); }
    catch (err) { return { ok: false, error: String((err && err.code) || 'internal') }; }
  });
  ipcMain.handle('module:openLog', async () => {
    try { await shell.openPath(LOG_PATH); return { ok: true, path: LOG_PATH }; } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // ─── ADP-390 (G9) — CrewPane hesabı yüzeyi (Ayarlar → Hesap) ────────────────
  // Renderer'a SIR GİTMEZ: yalnız durum (e-posta, lisans, seat, ürünler). Access
  // token / refresh token / lisans jetonu MAIN'de kalır (OpenAI key deseni).
  // ADP-520 — seatGate henüz yoksa bile requireLogin config'ten DOĞRU döner:
  // login duvarı fail-CLOSED kalır (gate'i "not_ready" yüzünden atlamak açık kapı olurdu).
  // ADP-614: gate henüz kurulmadıysa da renderer AYNI sözleşmeyi görsün (katman
  // alanları eksik kalmasın); etiketler tek kaynaktan (planCatalog).
  const accountState = () => (seatGate ? seatGate.evaluate() : {
    requireSeat: false, requireLogin: crewpaneIdConfig(process.env).requireLogin,
    signedIn: false, email: null, userId: null,
    licenseStatus: 'none', seat: false,
    tier: null, tierLabel: null, tierRank: 0, caps: null, accessProducts: [],
    products: [], productLabels: planCatalog.productLabels(),
    graceRemainingSeconds: 0,
  });
  // ADP-780-B — `scheme` kabloda taşınır: giriş ekranının "elle yapıştır" alanı,
  // bu kopyanın GERÇEKTEN dinlediği şemayı yazmalı. Renderer'da ikinci bir sabit
  // olsaydı dev build'de "crewpane:// ile başlayan adresi yapıştır" der, ama
  // main `crewpane-dev://` beklerdi → kullanıcı doğru adresi yapıştırıp reddedilirdi.
  // ONB-D3 — `bootSplash` de kabloda taşınır: açılış perdesini renderer çizer ama
  // AÇIK/KAPALI kararı ana süreçtedir (env yalnız burada okunur; renderer'da ikinci
  // bir kaynak olsaydı e2e harness'ının kapatma yolu sessizce etkisiz kalırdı).
  ipcMain.handle('crewpane:get', () => ({
    ok: true, scheme: APP_URL_SCHEME, bootSplash: gateOverrides(process.env).bootSplash, ...accountState(),
  }));
  ipcMain.handle('crewpane:signIn', async () => {
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    try {
      const res = await seatGate.signIn(); // SİSTEM TARAYICISI (webview YASAK)
      return { ok: true, url: res.url };
    } catch (e) {
      logLine(`crewpane:signIn error: ${e.message}`);
      return { ok: false, reason: 'sign_in_failed', detail: e.message };
    }
  });
  // ADP-703 — ÇIKIŞ artık YEREL DEPOYU da kapsar: oturum silinir, veri kökü anonim
  // köke döner ve uygulama yeniden başlar (hesap değişimi = yeniden başlatma, §3.3).
  // A hesabının verisi SİLİNMEZ — `accounts/<A>` olduğu gibi durur, tekrar girişte geri gelir.
  //
  // ÇALIŞAN AJAN GUARD'I (Eren'in açık korkusu): pane koşuyorsa çıkış SESSİZCE yapılmaz.
  // İlk çağrı `panes_running` ile REDDEDER ve listeyi döner; kullanıcı onaylarsa çağıran
  // `force:true` ile tekrar gelir. Kapanış yolu quit-snapshot'ı yazdığı için pane'ler
  // A'ya tekrar girildiğinde restore edilebilir (veri kaybı yok).
  //
  // ADP-863 — ÜÇ GİRİŞ YOLU, TEK KARAR YERİ:
  //   { probe:true } → HİÇBİR ŞEY YAPMAZ, yalnız "ne kapanacak" sayılarını + onay
  //                    metnini döner. Arayüz onay diyaloğunu bununla kurar; böylece
  //                    pane YOKKEN de kullanıcı yeniden başlatmayı ÖNCEDEN görür
  //                    (eskiden sessizce çıkıp yeniden başlıyordu — çökme sanılıyordu).
  //   (bayraksız)    → guard: pane varsa `panes_running` ile REDDEDER.
  //   { force:true } → kullanıcı onay diyaloğunda "Çıkış yap"a bastı; guard atlanır.
  // `force` YALNIZ kullanıcı onayının taşıyıcısıdır — sessiz bir bypass şalteri değil.
  ipcMain.handle('crewpane:signOut', async (_e, opts) => {
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const force = !!(opts && opts.force);
    const probe = !!(opts && opts.probe);
    const panes = runningPaneSummary();
    if (probe) {
      return { ok: false, reason: 'probe', panes, ...signOutConfirmCopy(panes), ...accountState() };
    }
    if (panes.length && !force) {
      return {
        ok: false,
        reason: 'panes_running',
        panes,
        ...signOutConfirmCopy(panes),
        ...accountState(),
      };
    }
    // ADP-876 — SIRA: önce pane'ler temiz kapanır (hesap kökü HÂLÂ A'yken defter
    // yazılır), sonra oturum kapanır, sonra yeniden başlatma. Eskiden pane'ler
    // ancak `before-quit` içinde ölüyordu, yani çıkış anında hâlâ canlıydılar.
    const closedPanes = closePanesForSignOut();
    await seatGate.signOut();
    const nextKey = accountScope.ANON_ACCOUNT_KEY;
    if (boundAccount && boundAccount.key !== nextKey) {
      relaunchForAccountChange(nextKey, 'signOut');
      return { ok: true, restarting: true, closedPanes, ...accountState() };
    }
    return { ok: true, closedPanes, ...accountState() };
  });

  // ─── RESET-03 — KURULUMU SIFIRLA ───────────────────────────────────────────
  //
  // İKİ KANAL, TEK KARAR YERİ. `reset:plan` KURU koşumdur (hiçbir şey silmez);
  // `reset:request` yıkıcı olandır ve onayı MAIN doğrular.
  //
  // ⚠️ RENDERER'A GÜVENİLMEZ. Onay sözcüğünün doğruluğu burada ölçülür (dil
  // main'de bilinir), yük `resetGate.sanitizeRequest` boğazından geçer ve
  // `execute`a level + keepLogs DIŞINDA hiçbir alan gitmez — özellikle YOL.
  // Hedefleri `installReset` zaten kendisi türetir (RESET-01 §2c).
  ipcMain.handle('reset:plan', async (_e, opts) => {
    const level = opts && opts.level === 'session' ? 'session' : 'full';
    try {
      const { deps } = resetContext((m) => logLine(`[reset] ${m}`));
      const plan = await installReset.plan({ ...deps, level });
      const panes = runningPaneSummary();
      // Yol adı UI'A GİTMEZ: hedefler `kind` + bayt olarak taşınır, `keeps`
      // i18n ANAHTARIDIR. Cümleyi renderer kendi sözlüğünden kurar.
      return {
        ok: true,
        level: plan.level,
        bytesTotal: plan.bytesTotal, // null = "hesaplanamadı" (0 DEĞİL)
        targets: plan.targets.map((t) => ({ kind: t.kind, bytes: t.bytes, entries: t.entries })),
        keeps: plan.keeps,
        warnings: plan.warnings,
        confirmWord: resetGate.expectedConfirmWord(appI18n.getLocale()),
        panes,
        ...signOutConfirmCopy(panes),
      };
    } catch (e) {
      logLine(`[reset] plan hatası (${(e && e.code) || 'ERR'})`);
      return { ok: false, reason: (e && e.code) || 'plan_failed' };
    }
  });

  // SIRA (RESET-01 §10.2 + kart §1): pane'leri kapat → kirayı bırak →
  // cihazı hesaptan çıkar (karar A) → çıkış → TELEMETRİ (silmeden ÖNCE) →
  // işaretçi → Chromium depoları → yeniden başlat. Kullanıcı dosyalarının
  // silinmesi BU SÜREÇTE OLMAZ; yeni süreç açılışta yapar (Windows kilidi).
  ipcMain.handle('reset:request', async (_e, raw) => {
    const req = resetGate.sanitizeRequest(raw);
    if (!req.ok) {
      logLine(`[reset] istek reddedildi (${req.reason})`);
      return { ok: false, reason: req.reason };
    }
    if (!resetGate.confirmMatches(req.confirmText, appI18n.getLocale())) {
      // Yazılan metin LOGLANMAZ (kullanıcı oraya başka bir şey yazmış olabilir).
      logLine('[reset] istek reddedildi (confirm_mismatch)');
      // ⚠️ SEBEP ADI RENDERER'IN SÖZLÜĞÜNE AİT. RESET-02 bilmediği bir sebebi
      // `failedReason` ile EKRANA BASAR ("Sebep: bad_confirm") — iç mekanizma
      // adı kullanıcı metnine sızardı ([[feedback_ui_copy_no_internals]]).
      // Tanınan küme: not_ready | confirm_mismatch | locked.
      return { ok: false, reason: 'confirm_mismatch' };
    }
    // signOut ile AYNI kapı: hesap servisi hazır değilken yıkıcı akış başlamaz.
    if (!seatGate) {
      logLine('[reset] istek reddedildi (not_ready)');
      return { ok: false, reason: 'not_ready' };
    }
    const log = (m) => logLine(`[reset] ${m}`);
    const { deps, instanceHome } = resetContext(log);
    log(`istek KABUL (seviye=${req.level} günlükleriSakla=${req.keepLogs ? 1 : 0})`);

    // 1) Pane'ler TEMİZ kapanır (ADP-876 sırası: defter hâlâ doğru köke yazılır).
    let closedPanes = 0;
    try { closedPanes = closePanesForSignOut(); } catch (e) { log(`pane kapatma hatası: ${e.message}`); }

    // 2-4) Bulut tarafı — hepsi BEST-EFFORT: çevrimdışı bir makine kendi
    // kurulumunu sıfırlayamıyor olsaydı, özelliğin var olma sebebi giderdi.
    if (req.level === 'full') {
      try { await seatGate.releaseDeviceLease(); } catch (e) { log(`kira bırakılamadı: ${e.message}`); }
      // KARAR A (RESET-R1 §3): kendi cihaz kaydını iptal et. `device.json` birazdan
      // silinecek → bir sonraki giriş YENİ bir cihaz kimliği üretir; eski satır
      // `revoked_at` boş kalırsa cihaz limitine HAYALET olarak sayılırdı.
      try {
        const ownId = accountScope.ensureDeviceId(instanceHome);
        const r = await seatGate.revokeDevice(ownId);
        log(`cihaz kaydı iptali ok=${r && r.ok ? 1 : 0}`);
      } catch (e) { log(`cihaz kaydı iptal edilemedi: ${e.message}`); }
    }
    try { await seatGate.signOut(); } catch (e) { log(`çıkış hatası: ${e.message}`); }

    // 5) TELEMETRİ — SİLMEDEN ÖNCE. `installId` ayar dosyasında yaşar ve tam
    // sıfırlamada gider; sonraya bırakılırsa olay ya kimliksiz kalır ya da YENİ
    // bir kurulum gibi görünür.
    let planned = null;
    try { planned = await installReset.plan({ ...deps, level: req.level }); } catch { /* kova 'unknown' */ }
    sendResetTelemetry({ level: req.level, source: 'settings', bytes: planned && planned.bytesTotal });

    // 6) İŞARETÇİ.
    //
    // ⚠️ DÜRÜSTÇE — `nonce` BUGÜN DOĞRULANMIYOR. RESET-R1 §2c "köprü jetonuyla
    // HMAC" öneriyordu; ölçüldü ki bu ŞU ANDA KURULAMAZ: köprü jetonu süreç
    // ömürlüdür ve `bridge.json` işaretçiyle birlikte silinen kökün içindedir —
    // yani okuyan süreçte doğrulanacak sır YOKTUR. Doğrulanmayan bir alanı
    // "kapı" diye anlatmak, olmayan bir korumayı iddia etmek olurdu
    // ([[capability-driven-affordance]]). Alan yine de rastgele doldurulur
    // (sözleşme bozulmasın) ama işaretçiyi GERÇEKTEN koruyanlar şunlardır:
    // dosya `instanceHome` içinde + 0o600 + 10 dakikadan eskisi YOK SAYILIR ve
    // SİLİNİR + `level` kapalı kümeden. Kalıcı çözüm RESET-05/06 kartına.
    try {
      installReset.writeMarker(instanceHome, {
        level: req.level,
        keepLogs: req.keepLogs,
        nonce: crypto.randomBytes(16).toString('hex'),
      }, deps);
      log('işaretçi yazıldı — silme YENİDEN BAŞLATMADAN SONRA');
    } catch (e) {
      log(`işaretçi YAZILAMADI (${(e && e.code) || 'ERR'}) — sıfırlama İPTAL`);
      // 'locked' = renderer'ın tanıdığı sebep ("dosyalar kullanımdaydı, kapatıp aç").
      // Doğru cümle budur: işaretçi yazılamıyorsa veri kökü erişilemez/kilitlidir.
      return { ok: false, reason: 'locked' };
    }

    // 7) Chromium depoları: çalışırken güvenli tek yol Electron'un KENDİ API'si
    // (Local Storage / IndexedDB / Cookies / Cache). `Local State` KASTEN
    // silinmez — Windows DPAPI anahtarı orada ve `auth/` gidince zaten işlevsiz
    // (ADP-943 giriş döngüsü yapısal olarak doğmaz).
    try {
      const { session } = require('electron');
      await session.defaultSession.clearStorageData();
      await session.defaultSession.clearCache();
      log('tarayıcı depoları boşaltıldı');
    } catch (e) { log(`tarayıcı depoları boşaltılamadı: ${e.message}`); }

    // 8) Yeniden başlat — MEVCUT yol yeniden kullanılır (kilit bırakma +
    // relaunch + kapanış nöbetçisi orada; ikinci bir relaunch = ikinci bir gerçek).
    relaunchForAccountChange(accountScope.ANON_ACCOUNT_KEY, 'reset');
    return { ok: true, restarting: true, closedPanes, level: req.level };
  });

  // ── TASK-CLEAN — GÖREV TEMİZLEME KÖPRÜSÜ (Brain Backend) ─────────────────────
  ipcMain.handle('task:cleanTeamDone', async (_e, opts) => {
    try {
      const taskBrainService = require('./src/services/taskBrainService.cjs');
      return await taskBrainService.cleanTeamDoneTasks(opts);
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('task:cleanAll', async () => {
    try {
      const taskBrainService = require('./src/services/taskBrainService.cjs');
      return await taskBrainService.cleanAllTasks();
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('task:listSummary', async () => {
    try {
      const taskBrainService = require('./src/services/taskBrainService.cjs');
      return await taskBrainService.listTasksSummary();
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });


  // ADP-703 — hesap deposu durumu (Ayarlar + e2e sızıntı nöbeti okur). SIR İÇERMEZ.
  ipcMain.handle('account:get', () => ({
    ok: true,
    accountKey: boundAccount ? boundAccount.key : null,
    userId: boundAccount ? boundAccount.userId : null,
    email: boundAccount ? boundAccount.email : null,
    root: boundAccount ? boundAccount.root : null,
    deviceId: boundAccount ? boundAccount.deviceId : null,
    instanceRoot: instancePaths.instanceHome(),
    runningPanes: runningPaneSummary().length,
  }));

  // ADP-703 — renderer companyId'yi çözünce meta'ya YAZ (ADP-704 bulut eşlemesi bunu
  // kullanır). Yol companyId'ye BAĞLI DEĞİL (§3.1) — bu yalnız kayıt.
  ipcMain.handle('account:setCompany', (_e, companyId) => {
    if (!boundAccount) return { ok: false, reason: 'not_bound' };
    const id = typeof companyId === 'string' && companyId.trim() ? companyId.trim() : null;
    try {
      accountScope.upsertAccountMeta(boundAccount.root, { companyId: id });
      return { ok: true, companyId: id };
    } catch (e) {
      logLine(`[account] companyId yazılamadı: ${e.message}`);
      return { ok: false, reason: 'write_failed' };
    }
  });
  // ADP-719 — GİRİŞ DÖNÜŞÜ DOĞRU UYGULAMAYA MI GELİYOR? Login duvarı bunu okur
  // ve sorun varsa kullanıcıya SEBEBİ + tek-tık düzeltmeyi gösterir. `repair:true`
  // ile şema sahipliği bu uygulamaya geri alınır (kullanıcı düğmesine bağlı).
  // SIR İÇERMEZ. Sessiz dosya silme YOK — Electron tarafı yalnız LaunchServices
  // eşlemesini düzeltir; başka bir paketi kaldırmak kullanıcının kararıdır ve
  // ekranda yol/isim ile gösterilir.
  ipcMain.handle('crewpane:schemeHealth', async (_e, opts) => {
    try {
      if (opts && opts.repair) {
        // ADP-954 — ŞEMA SABİT YAZILMAZ. Burada `'crewpane'` sabitti: dev/test
        // build'inde "Onar" düğmesi PROD şemasını talep ediyor (ADP-780-B'nin
        // kanal ayrımını bozuyor) ve kullanıcının GERÇEKTEN dinlediği şemayı
        // (crewpane-dev) hiç ölçmüyordu → onarım "başarılı" görünüp giriş
        // yine gelmiyordu. Tek boğaz appScheme.cjs (APP_URL_SCHEME).
        schemeVerdict = await schemeOwnership.claimAndVerify({
          app, scheme: APP_URL_SCHEME, log: logLine,
          allowDevClaimEnv: 'CREWPANE_ALLOW_DEV_PROTOCOL_CLAIM',
          automated: IS_AUTOMATED_SESSION,
          automatedReason: AUTOMATED_SESSION_REASON,
          // LX-SCHEME-01 — platform AÇIK geçer (ölçülmüş ders PIPE-03: bir
          // fonksiyonun `process.platform` yedeğine güvenen çağrı, yanlış
          // platformda sessizce koşar). Linux dalını sürükleyen tek anahtar bu.
          platform: process.platform,
        });
      }
      return { ok: true, ...(schemeVerdict || { severity: null, conflicts: [] }) };
    } catch (e) {
      logLine(`crewpane:schemeHealth error: ${e.message}`);
      return { ok: false, reason: 'check_failed', severity: null, conflicts: [] };
    }
  });
  // LX-SAFESTORAGE-01 (ADR §9 madde 2) — GİRİŞ DUVARI "oturum saklanabilecek mi"yi
  // SORABİLSİN. Açılışta ölçülen hüküm okunur; burada YENİDEN ölçüm YOK ve SIR YOK
  // (yalnız arka ucun adı + kullanılabilirlik + sözlük anahtarı döner).
  ipcMain.handle('crewpane:secretBackend', async () => {
    try {
      const s = secretBackendState.secretBackendState();
      return {
        ok: true,
        measured: s.measured,
        available: s.available,
        backend: s.backend,
        plaintext: s.plaintext,
        canStore: s.canStore,
        reasonKey: s.reasonKey,
      };
    } catch (e) {
      logLine(`crewpane:secretBackend error: ${e.message}`);
      return { ok: false, measured: false, canStore: null, reasonKey: null };
    }
  });
  // ADP-719 — İKİNCİ GİRİŞ YOLU: deep-link hiç dönmezse kullanıcı tarayıcının
  // adres çubuğundaki dönüş bağlantısını yapıştırır. Deep-link ile AYNI
  // işleyiciye gider (handleAuthUrl) — ikinci bir giriş yolu YAZILMAZ.
  ipcMain.handle('crewpane:pasteCallback', async (_e, url) => {
    const text = typeof url === 'string' ? url.trim().replace(/^["']|["']$/g, '') : '';
    // ADP-954 — handleAuthUrl ile AYNI kural: şema kıyası harf-duyarsız
    // (RFC 3986 §3.1). Kullanıcı adres çubuğundan kopyaladığı bağlantıyı
    // farklı harf düzeniyle yapıştırdığında "geçersiz" duvarına çarpmasın.
    if (!text.toLowerCase().startsWith(APP_URL_PREFIX.toLowerCase()) || !text.includes('code=')) {
      return { ok: false, reason: 'invalid_url', expectedPrefix: APP_URL_PREFIX };
    }
    logLine('crewpane:pasteCallback — elle yapıştırılan dönüş bağlantısı işleniyor');
    handleAuthUrl(text);
    return { ok: true };
  });
  ipcMain.handle('crewpane:refresh', async () => {
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const res = await seatGate.refreshLicense();
    return { ok: !!res.ok, reason: res.reason, ...accountState() };
  });
  // ADP-646 — "Paket al": SİSTEM TARAYICISINDA faturalandırma sayfası. Ödeme akışı
  // app'in içinde AÇILMAZ (kart bilgisi app penceresine girmez — login ile aynı
  // RFC 8252 duruşu). Adres crewpaneId.cjs'te loginUrl'den TÜRETİLİR; app içinde
  // ikinci bir sabit yok, e2e yerel stack'i de otomatik doğru adresi alır.
  ipcMain.handle('crewpane:openBilling', async () => {
    const url = crewpaneIdConfig(process.env).billingUrl;
    try {
      await shell.openExternal(url);
      logLine(`crewpane:openBilling → ${url}`);
      return { ok: true, url };
    } catch (e) {
      logLine(`crewpane:openBilling error: ${e.message}`);
      return { ok: false, reason: 'open_failed', url };
    }
  });

  // ─── SEC-01 — CİHAZ DEFTERİ (Ayarlar → Hesap) ──────────────────────────────
  // Cihaz TAVANI sunucuda zorlanıyor. Bu iki uç, tavanın müşteriyi KİLİTLEMEMESİ
  // için var: kullanıcı kendi cihazını kendisi çıkarabilmeli. Sır GEÇMEZ —
  // erişim jetonu main'de kalır, renderer yalnız listeyi ve sonucu görür.
  ipcMain.handle('crewpane:devices', async () => {
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const res = await seatGate.listDevices().catch((e) => ({ ok: false, reason: 'error', detail: e.message }));
    if (!res.ok) logLine(`crewpane:devices başarısız (${res.reason})`);
    return res;
  });
  ipcMain.handle('crewpane:deviceRevoke', async (_e, deviceId) => {
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const id = String(deviceId || '');
    if (!id) return { ok: false, reason: 'missing_device_id' };
    const res = await seatGate.revokeDevice(id)
      .catch((e) => ({ ok: false, reason: 'error', detail: e.message }));
    logLine(`crewpane:deviceRevoke ${id} → ${res.ok ? 'çıkarıldı' : res.reason}`);
    return res;
  });
  // SEC-02 — "DİĞER CİHAZLARI BIRAK". `deviceRevoke`tan AYRI bir uçtur çünkü AYRI
  // bir şey yapar: koltuğu boşaltır ama cihazı hesapta BIRAKIR. Aynı uca
  // bağlasaydık kullanıcı "bırak" derken makinesini hesabından silmiş olurdu.
  ipcMain.handle('crewpane:deviceReleaseOthers', async () => {
    if (!seatGate) return { ok: false, reason: 'not_ready' };
    const res = await seatGate.releaseOtherDevices()
      .catch((e) => ({ ok: false, reason: 'error', detail: e.message }));
    // SONUÇ ÖLÇÜLEREK döner: "bıraktım" demek "artık girebiliyorum" demek DEĞİL.
    // Bırakmanın ardından seatGate lisansı tazeler; hâlâ reddediliyorsak ekran
    // bunu SÖYLEMELİ (başarı cümlesi, başarısızlığın üstünü örtemez).
    const after = (() => { try { return seatGate.state(); } catch { return null; } })();
    const denied = !!(after && after.device && after.device.denied);
    logLine(`crewpane:deviceReleaseOthers → ${res.ok ? `${res.released} cihaz bırakıldı` : res.reason}`
      + ` (ret devam=${denied})`);
    return { ...res, denied };
  });

  // ADP-660 — PLAN ÖZETİ (nudge + Ayarlar): hangi katmandayız, ne zorlanıyor,
  // tavan/kullanım. Karar ÜRETMEZ (tek karar yeri planLimits.decide, çağıranı main);
  // renderer bu özetle yalnız BİLGİ gösterir — ikinci bir limit mantığı kurmaz.
  ipcMain.handle('plan:get', () => ({
    ok: true,
    ...planLimits.describe(seatGate ? seatGate.state() : null, {
      agents: ptys.size,
      // BL-01 — özet KULLANIMI da göstermeli, yoksa Ayarlar "1/1 alan" yerine
      // "0/1" yazar ve kullanıcı reddi anlamsız bulur. Sayım yolu, kararın
      // kullandığı yolun AYNISI (ikinci bir sayaç yok).
      workspaces: (() => {
        try { return workspaceOnboarding.knownWorkspaces().length; } catch { return 0; }
      })(),
      // SEC-01 — cihaz sayısı SUNUCUDAN gelir (istemcide sayılamaz: diğer
      // makineleri görmüyoruz). Sunucu henüz bir şey söylemediyse 0 kalır ve
      // özet "0/1" gösterir — Ayarlar → Hesap gerçek listeyi ayrıca çeker.
      devices: (() => {
        const s = seatGate ? seatGate.state() : null;
        return (s && s.device && Number(s.device.registered_active || s.device.active)) || 0;
      })(),
      // SEC-02 — AYNI ANDA AKTİF sayısı da sunucudan gelir. Ayrı bir sayaçtır:
      // "kaç cihazım var" ile "şu an kaçı açık" iki farklı soru, iki farklı ret.
      devicesConcurrent: (() => {
        const s = seatGate ? seatGate.state() : null;
        return (s && s.device && Number(s.device.concurrent_active)) || 0;
      })(),
    }),
    // "Yükselt" hedefi kapı ekranıyla AYNI adres (app içinde ikinci sabit yok).
    billingUrl: crewpaneIdConfig(process.env).billingUrl,
  }));

  // ─── BL-03 — YÜKSELTME SONRASI YENİDEN ÖLÇÜM ────────────────────────────────
  // Sorun: lisans jetonu +72s yaşar ve açılışta/girişte tazelenir. Kullanıcı
  // tarayıcıda Pro'ya geçtiğinde app'in elindeki jeton HÂLÂ Basic'tir → "yükselttim
  // ama hâlâ kilitli". Bu, iade sebebi ve destek yüküdür; çözümü kullanıcıya
  // "uygulamayı yeniden başlat" dedirtmek DEĞİL, reddin bittiği yerde tazelemektir.
  //
  // İki adım, İKİSİ DE MEVCUT UÇLAR (yeni ödeme/karar yolu AÇILMADI):
  //   1. `seatGate.refreshLicense()` — `crewpane:refresh`in çağırdığı FONKSİYONUN
  //      AYNISI (ağ hatasında cached jeton korunur; offline ≠ kilit).
  //   2. `planLimits.decide` — reddi üreten KARARIN AYNISI, reddin KENDİ
  //      (feature, current) çiftiyle. Renderer "sınır kalktı mı"yı KENDİ hesaplamaz:
  //      ikinci bir tavan mantığı iki gerçek olurdu (ADP-660 duruşu).
  // `describe(snapshot)` sayaçsız çağrılır — burada sorulan tek şey KATMAN etiketi;
  // yetenek kararı yukarıdaki `decide` satırından gelir.
  ipcMain.handle('plan:recheck', async (_event, input) => {
    const feature = typeof (input && input.feature) === 'string' ? input.feature : '';
    const asked = Number(input && input.current);
    const current = Number.isFinite(asked) ? asked : 0;
    let refreshed = false;
    let reason = null;
    if (seatGate) {
      try {
        const res = await seatGate.refreshLicense();
        refreshed = !!(res && res.ok);
        reason = (res && res.reason) || null;
      } catch (e) {
        reason = 'refresh_failed';
        logLine(`plan:recheck — jeton tazelenemedi (${e.message}) — eldeki jetonla ölçülür`);
      }
    }
    const snapshot = seatGate ? seatGate.state() : null;
    const decision = planLimits.decide({ snapshot, feature, current });
    const summary = planLimits.describe(snapshot);
    const allowed = decision.allowed !== false;
    logLine(`plan:recheck ${feature || '-'}(${current}) → tazelendi=${refreshed}${reason ? ` (${reason})` : ''} katman=${summary.tier} izin=${allowed}`);
    return {
      ok: true,
      refreshed,
      reason,
      feature,
      allowed,
      tier: summary.tier,
      tierLabel: summary.tierLabel,
      // Hâlâ reddediliyorsa hedef katman DEĞİŞMİŞ olabilir (ör. Basic→Pro yetmedi):
      // düğmenin metni her zaman GÜNCEL karardan beslenir.
      requiredTierLabel: allowed ? null : (decision.requiredTierLabel || null),
    };
  });

  // ─── ADP-622 — UYGULAMA DB KİMLİĞİ (renderer) ───────────────────────────────
  // İstisna, bilinçli: `crewpaneApi`den sır GEÇMEZ kuralının aksine bu kanal
  // renderer'a ACCESS TOKEN verir — çünkü Supabase istemcisi renderer'da yaşıyor
  // ve `Authorization: Bearer` başlığını O atmak zorunda (ADP-621'in kablosu).
  // Sınırlar: (a) YALNIZ access token — refresh token ve oturum dokümanı main'de
  // (safeStorage) kalır, (b) yalnız jetonu İMZALAYAN projeye gider (appDbIdentity;
  // farklı proje → 'different_project', jeton üretilmez bile), (c) zaten aynı
  // renderer'a giden anon key ile aynı güven sınırı — RLS yine sunucuda zorlar.
  // ADP-646 — GÖREV/OFİS kimliği de lisansa bağlı: paketsiz kullanıcıya jeton verilmez
  // → görev panosu yazamaz/okuyamaz (istemci anon'a düşer, RLS keser).
  // ADP-773 — karar `appDbTokenFor`da TEK yerde; mobil ofis de oradan geçer.
  ipcMain.handle('appdb:token', () => appDbTokenFor('appdb:token'));
  // ── TC-01 — ONAY KARTININ KARARI (ADR §4.2) ─────────────────────────────────
  // Kartın "Ekibe ekle / Vazgeç" tıklaması BURAYA düşer ve onay jetonu YALNIZ burada
  // doğar. Liderin "kullanıcı onayladı" demesi onay DEĞİLDİR: jeton main'de üretilir,
  // tek bir öneriye bağlıdır, tek kullanımlıktır ve TTL'si vardır (ADR-026 disiplini).
  //
  // Kullanıcının DÜZENLEDİĞİ satırlar da aynı süzgeçten geçer (katalog dışı rol düşer,
  // para alanı silinir, tavan yeniden ölçülür) — karar tek yerde kalsın.
  //
  // TC-FIX-01 (RESEARCH-TC-01 §1 Halka-1, Eren kararı 18.09 seçenek a) — TIKLAMA
  // KURULUMDUR. Eskiden bu handler yalnız jeton üretip renderer'a dönüyordu; apply'ı
  // ancak LİDER çağırabiliyordu ve ona tıklamayı bildiren hiçbir yol yoktu → patron
  // "Ekibe ekle"ye basıp bekliyor, hiçbir satır yazılmıyor, ekranda hiçbir şey
  // olmuyordu (izole Electron'da ölçüldü: tıklama + 20 sn → DB +0). Artık jeton
  // doğduğu yerde HARCANIR: main apply'ı kendisi koşturur (`team-compose:undo-request`in
  // deseni — köprünün IPC turu `composeTransport`ta saklı) ve sonucu lidere pane'ine
  // teslim eder. Jeton disiplini DEĞİŞMEDİ: yine main üretir, yine tek kullanımlık,
  // yine tek öneriye bağlı; değişen tek şey "kim harcıyor" (lider değil ürün).
  ipcMain.handle('team-compose:decision', async (_e, req) => {
    const ledger = ensureComposeLedger();
    const proposalId = String((req && req.proposalId) || '');
    const decision = String((req && req.decision) || '');
    if (decision === 'approve' && Array.isArray(req && req.rows)) {
      const allowed = Array.isArray(req.catalogSlugs) ? req.catalogSlugs : [];
      // Beyaz liste GELMEDİYSE kullanıcı düzenlemesini kabul ETME: boş bir katalogla
      // süzmek HER satırı düşürürdü (sessiz "onayladım ama kimse gelmedi"). Bu durumda
      // önerinin KENDİ satırları (zaten süzülmüş) geçerli kalır.
      if (allowed.length) {
        const { rows } = teamComposeCore.sanitizeRows(req.rows, allowed);
        const cap = teamComposeCore.capDecision({
          rows,
          mode: (req && req.mode) || 'team',
          sessionInstalls: ledger.sessionInstalls(),
        });
        if (!cap.ok) return { ok: false, code: cap.code, error: cap.error || cap.reason };
        req = { ...req, rows };
      } else {
        req = { ...req, rows: undefined };
      }
    }
    const res = ledger.decide(proposalId, {
      decision,
      teamName: req && req.teamName,
      rows: req && req.rows,
    });
    if (!res.ok) return { ok: false, code: res.code, error: res.reason };
    if (res.rejected) return { ok: true, rejected: true };
    // 🔴 Jeton RENDERER'A DÖNMEZ ve lidere de gitmez: onu harcayan main'in kendisidir.
    // Köprü turu yoksa (öneri bu oturumda köprüden geçmedi — köprüsüz geliştirme /
    // DOM olayıyla açılmış kart) kurulacak yol da yoktur; kart bunu SÖYLER, "kurdum"
    // demez (sessizce jeton verip beklemek tam da düzeltilen kusurdu).
    if (!composeTransport) {
      return { ok: false, code: 'no-transport', error: 'Kurulum şu an yapılamıyor — ekip lideri bağlı değil.' };
    }
    const p = res.proposal;
    let applied;
    try {
      applied = await teamComposeRequest(
        {
          action: 'apply',
          proposalId,
          approvalToken: res.approvalToken,
          leaderId: p.leaderId,
          department: p.department,
          source: 'user-click',
        },
        composeTransport,
      );
    } catch (err) {
      applied = composeFail(500, 'main', String((err && err.message) || err));
    }
    if (applied.status !== 200 || !applied.body || !applied.body.ok) {
      const error = (applied.body && applied.body.error) || 'ekip kurulamadı.';
      logLine(`team compose: onay tıklandı ama apply DÜŞTÜ (${applied.status}/${applied.body && applied.body.code}) — ${error}`);
      // Lider "kurdum" DEMESİN: patronun onayı vardı, kurulum yoktu — ikisi de söylenir.
      notifyLeaderCompose(
        p.leaderId,
        `❌ [EKİP KURUCU] Patron "${p.teamName || 'ekip'}" önerisini onayladı ama kurulum BAŞARISIZ: ${error} ` +
          '"ekibi kurdum" DEME; patron kartta hatayı görüyor, yeniden deneyebilir.',
      );
      return { ok: false, code: (applied.body && applied.body.code) || 'apply', error };
    }
    const body = applied.body;
    notifyLeaderCompose(
      p.leaderId,
      `✅ [EKİP KURUCU] Patron onay kartında "Ekibe ekle"ye bastı. ${teamComposeCore.composeReceiptText(body)}`,
    );
    return { ok: true, applied: true, proposalId, receipt: body.receipt || null, wingSlug: body.wingSlug || null };
  });

  /**
   * TC-FIX-01 — kurulum sonucunu LİDERİN pane'ine yaz (lider apply çağırmadığı için
   * bunu başka türlü öğrenemez). Ürünün mevcut primitifleri: pane bulma supervisor'ın
   * `findLeaderPane` kuralıyla aynı (agentId eşit + execution pane DEĞİL), kapı
   * `sampleLeaderGate` (iki tampon örneği + tuş sessizliği — ADP-667/692), yazım
   * `deliverToPane` (ENT-F1: metin bir kez, Enter ölçülerek). Lider meşgulse kısa
   * aralıklarla yeniden denenir; bütçe dolarsa VAZGEÇİLİR ve log söyler — şerit ve
   * makbuz zaten patronun önündedir, lider apply çağırırsa "zaten kuruldu"yu alır.
   * Beklenmez (fire-and-forget): kart, satırlar yazılınca kapanmalı, lider uyanınca değil.
   */
  function notifyLeaderCompose(leaderId, text) {
    const id = String(leaderId || '');
    if (!id) return;
    const findPane = () => {
      for (const [paneId, e] of ptys) if (e.agentId === id && e.disallowSubagent !== true) return paneId;
      return null;
    };
    (async () => {
      const deadline = Date.now() + COMPOSE_NOTIFY_BUDGET_MS;
      let tries = 0;
      while (Date.now() < deadline) {
        const paneId = findPane();
        if (!paneId) {
          logLine(`team compose: lider ${id} pane'i yok — kurulum notu teslim EDİLMEDİ (şerit patronun önünde)`);
          return;
        }
        tries += 1;
        const gate = await sampleLeaderGate(paneId);
        if (gate.safe) {
          const res = await deliverToPane(paneId, text, { label: `ekip-kurucu ${id}` });
          logLine(`team compose: lider ${id} pane=${paneId} kurulum notu ${res.delivered ? 'TESLİM EDİLDİ' : 'yazıldı, teslim DOĞRULANAMADI'} (deneme ${tries})`);
          return;
        }
        await dispatchSleep(COMPOSE_NOTIFY_RETRY_MS);
      }
      logLine(`team compose: lider ${id} ${tries} denemede hep meşguldü — kurulum notu teslim EDİLMEDİ`);
    })().catch((err) => logLine(`team compose: lider notu hata (${String((err && err.message) || err)})`));
  }
  /** TC-01 — kartın/şeridin okuduğu ayar kademesi (§9.7). */
  ipcMain.handle('team-compose:autonomy', () => ({ ok: true, autonomy: composeAutonomy() }));
  // ── TC-02 — KULLANICININ GERİ ALMASI (IPC-CONTRACT §3.6'nın EKSİK YÖNÜ) ─────
  // §3.6 geri almayı YALNIZ main→renderer tanımlıyordu (liderin `action:'undo'`
  // çağrısı). Oysa "10 dakika içinde geri al" sözünü veren şerit KULLANICININ
  // önündedir ve düğmesi ters yönde bir kanal ister; o kanal olmadan düğme
  // basılıyor ama hiçbir şey olmuyordu. Kanal İNCE: karar, pencere ve silme
  // sırası yine `teamComposeRequest`in undo dalındadır — burada ikinci bir
  // geri alma yolu YOK, yalnız aynı yolun renderer'dan açılan kapısı var.
  ipcMain.handle('team-compose:undo-request', async (_e, req) => {
    const proposalId = String((req && req.proposalId) || '').trim();
    if (!proposalId) return { ok: false, code: 'bad-request', error: 'Geri alınacak kurulum belirtilmedi.' };
    if (!composeTransport) {
      // Kurulum bu oturumda köprüden geçmediyse turu açacak kimse yok.
      return { ok: false, code: 'no-transport', error: 'Geri alma şu an yapılamıyor.' };
    }
    try {
      const res = await teamComposeRequest({ action: 'undo', proposalId }, composeTransport);
      if (res.status === 200) return { ok: true, ...res.body };
      return { ok: false, code: res.body && res.body.code, error: res.body && res.body.error };
    } catch (err) {
      return { ok: false, code: 'main', error: String((err && err.message) || err) };
    }
  });
  // ─── INT-OBS-01 — TELEMETRİ OTOMATİK KURULUMU ──────────────────────────────
  // Renderer'dan gelen tek şey `service` (+ opsiyonel org seçimi). JETON RENDERER'DAN
  // GELMEZ: kasadan main tarafında çözülür. Böylece "Bağla"ya basmak, sırrı bir daha
  // IPC sınırından geçirmeyi GEREKTİRMEZ (ADP-586 kırmızı çizgisi burada da geçerli).
  const PROVISION_SERVICES = new Set(['sentry', 'posthog']);

  // ═══ BR-04 (ADR §6) — VENDOR/MÜŞTERİ AYRIMI: ASIL KAPI BURADA ═══════════════
  //
  // Bu akış MÜŞTERİNİN İŞİ DEĞİL: bizim ürün telemetrimizin projelerini
  // (crewpane-prod · crewpane-dev · crewpane-com — provisionApi.DEFAULT_PROJECT_SLUGS)
  // MÜŞTERİNİN Sentry/PostHog organizasyonunda AÇAR ve DSN'leri oraya bağlar.
  // Yani müşterinin bağladığı hesapla bizim vendor kurulumumuz TAM OLARAK BURADA
  // karışırdı: müşterinin kotası bizim telemetrimizle yanar, bizim projelerimiz
  // onun panosunda görünür, onun anahtarı bizim adımıza YAZMA yapar.
  //
  // UI'ı gizlemek YETMEZ (renderer bir bug/devtools ile bu kanalı yine çağırabilir):
  // kapı MAIN'de kapanır. `isCustomerBuild()` env OKUMAZ (ADP-646) → müşteri
  // CREWPANE_INSTANCE=dev diyerek bu kapıyı AÇAMAZ.
  const VENDOR_ONLY = {
    ok: false,
    code: 'vendor-only',
    message: 'Bu kurulum akışı CrewPane’in kendi telemetrisi içindir ve bu yapıda kapalıdır.',
  };
  /** @returns {null|object} null = geç; nesne = REDDET (aynı şekilli hata cevabı). */
  function vendorOnlyGate() {
    return vendorSurface.isCustomerSurface() ? VENDOR_ONLY : null;
  }

  /** Renderer girdisini daralt — serbest metin YOK, yalnız beklenen biçim. */
  function provisionInput(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const service = typeof input.service === 'string' ? input.service.trim() : '';
    if (!PROVISION_SERVICES.has(service)) return null;
    const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 200).replace(/[^A-Za-z0-9._-]/g, '') : null);
    return { service, orgSlug: clean(input.orgSlug) || null, teamSlug: clean(input.teamSlug) || null };
  }

  ipcMain.handle('telemetry:provision', (_event, raw) =>
    supervisorFor('telemetry-provision').runAsync(
      'provision',
      async () => {
        const denied = vendorOnlyGate();
        if (denied) { logLine('telemetry-provision: müşteri build’inde REDDEDİLDİ (vendor-only)'); return denied; }
        const input = provisionInput(raw);
        if (!input) return { ok: false, code: 'unknown-service', message: 'Bilinmeyen servis.' };
        const token = telemetryTokenFor(input.service);
        if (!token) {
          // Sessiz başarısızlık yasak: neyin eksik olduğunu ve nereden ekleneceğini söyle.
          return {
            ok: false,
            code: 'not-connected',
            message: credentialGate.missingMessageFor(input.service),
          };
        }
        const res = await telemetryProvisioning().provisioner.connect({ ...input, token });
        logLine(`telemetry-provision: ${input.service} sonuç=${res.ok ? 'OK' : res.code}`);
        return res;
      },
      { ok: false, code: 'error', message: 'Kurulum çalıştırılamadı.' },
    ));

  // Doğrulama: GERÇEK olay gönder + panoda göründüğünü API'den OKU. Kanal kilidi
  // gereği YALNIZ içinde bulunulan kanalın projesine yazar (telemetryProvision).
  ipcMain.handle('telemetry:verify', (_event, raw) =>
    supervisorFor('telemetry-provision').runAsync(
      'verify',
      async () => {
        const denied = vendorOnlyGate();
        if (denied) { logLine('telemetry-verify: müşteri build’inde REDDEDİLDİ (vendor-only)'); return denied; }
        const input = provisionInput(raw);
        if (!input) return { ok: false, code: 'unknown-service', message: 'Bilinmeyen servis.' };
        const token = telemetryTokenFor(input.service);
        if (!token) return { ok: false, code: 'not-connected', message: credentialGate.missingMessageFor(input.service) };
        const out = await telemetryProvisioning().provisioner.verify(input.service, token);
        // BR-01 (ADR §2.4) — GERÇEK bir okuma başarılı olduysa anahtarın çalıştığı
        // kanıtlanmıştır; keşif cevabındaki `lastVerifiedAt` bunu ajana taşır.
        if (out && out.ok) await stampIntegrationVerified(input.service);
        return out;
      },
      { ok: false, code: 'error', message: 'Doğrulama çalıştırılamadı.' },
    ));

  // Durum yüzeyi (F4) — SIR İÇERMEZ (yalnız maskeli değerler + proje/kanal adları).
  ipcMain.handle('telemetry:provisionStatus', () =>
    supervisorFor('telemetry-provision').runAsync(
      'status',
      async () => {
        // BR-04 — durum yüzeyi de vendor-only: müşteri build'inde bu ekran HİÇ
        // çizilmediği için veri de üretilmez (boş liste = "böyle bir yüzey yok").
        if (vendorSurface.isCustomerSurface()) return { ok: true, channel: null, services: [], vendorOnly: true };
        const services = await telemetryProvisioning().provisioner.status();
        // INT-OBS-02 — hub kartı yalnız store'u değil ÇALIŞAN kaynağı da yansıtır:
        // anahtar `~/.crewpane/telemetry.env`e elle yazılmış olabilir (eski/geçici yol)
        // ve telemetri ORADAN akıyor olabilir; store boş diye "Kurulmadı" demek yanlış
        // durum bildirir. Kopya env veriyoruz: loadDsnEnvFromCrewPane verilen nesneye
        // yazar, process.env mutasyona uğramaz. Renderer'a yalnız VARLIK gider (boolean).
        const legacyEnv = telemetryMod.loadDsnEnvFromCrewPane({ env: { ...process.env } });
        const presence = provisionStoreMod.envPresence(legacyEnv);
        return {
          ok: true,
          channel: telemetryChannelMod.resolveChannel(),
          services: services.map((s) => ({ ...s, envKeys: presence[s.service] || null })),
        };
      },
      { ok: false, channel: null, services: [] },
    ));

  // ═══════════════════════════════════════════════════════════════════════
  // B-01 (Faz D) — İNCELEME → MERGE YÜZEYİ (B-02/B-03 kart UI'sı bunu tüketir)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Durum makinesi ve merge YÜRÜTMESİ MAIN'de kalır (§2.1 ilke 2). Renderer yalnız
  // İSTER: hangi görev, onay verdi mi. Branch adı, worktree yolu ve hedef dal
  // renderer'dan ASLA alınmaz — hepsi görev kaydından + yerel defterden türer (G-1).
  //
  // `worktree:review` HİÇBİR ŞEYİ DEĞİŞTİRMEZ: ölçüm + saf karar döner (kartın verisi).
  // `worktree:merge` kapıların HEPSİNİ TEKRAR koşar — "kart yeşildi" bir yetki belgesi
  // değildir (kart ile tıklama arasında ajan yeni commit atmış olabilir).

  // ═══════════════════════════════════════════════════════════════════════════
  // GIT-BB-CLOUD-01 — PROJE AYARI KÖPRÜSÜ (Ayarlar → Projeler)
  // ═══════════════════════════════════════════════════════════════════════════
  // İzolasyon kararı iki yerde yaşar ve bu BİLİNÇLİDİR:
  //   • BULUT (`projects.isolation|default_branch|merge_approval`) — takımın gördüğü
  //     ayar; board ve MCP oradan okur, cihazdan cihaza taşınır.
  //   • YEREL (`settings.projectIsolation` + `worktrees.json`) — spawn anında main'in
  //     BAKTIĞI yer (projectIsolationMode / worktreeStore.getProject). Worktree bu
  //     makinede açılır; kararı ağ çağrısına bağlamak spawn'ı ağa bağımlı kılardı.
  // Ayar ekranı ikisini birlikte yazar; bu köprü YEREL yarısıdır. Renderer bir YOL
  // dayatamaz (G-1): repoPath'i main kendisi çözer.
  ipcMain.handle('project:config:get', (_e, input) => {
    const wanted = Array.isArray(input?.slugs)
      ? input.slugs.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim().toLowerCase())
      : [];
    const s = agentSettings.readSettings();
    const isoMap = (s && s.projectIsolation && typeof s.projectIsolation === 'object') ? s.projectIsolation : {};
    const repoMap = (s && s.projectRepos && typeof s.projectRepos === 'object') ? s.projectRepos : {};
    let stored = {};
    try { stored = worktreeStore.listProjects(crewpaneHome()) || {}; } catch { stored = {}; }
    const slugs = [...new Set([...wanted, ...Object.keys(isoMap), ...Object.keys(repoMap), ...Object.keys(stored)])];
    const projects = slugs.map((slug) => {
      const rec = (() => { try { return worktreeStore.getProject(slug, crewpaneHome()); } catch { return null; } })();
      const repo = projectRepos.resolveProjectRepo(slug, agentWorkspaceRoot, {
        settings: s, store: worktreeStore, homedir: crewpaneHome(), log: () => {},
      });
      return {
        slug,
        isolation: isoMap[slug] === 'worktree' ? 'worktree' : 'off',
        defaultBranch: (rec && rec.defaultBranch) || 'dev',
        // Yol GÖSTERİLİR ama kullanıcı buradan yazamaz: "izolasyon açık ama repo yok"
        // hâli EKRANDA görünmezse spawn anında sürpriz bir blokla karşılaşılır (H-5).
        repoPath: repo ? repo.repoPath : null,
        repoSource: repo ? repo.source : null,
      };
    });
    return { ok: true, workspaceRoot: agentWorkspaceRoot, projects };
  });

  ipcMain.handle('project:config:set', (_e, input) => {
    const slug = typeof input?.slug === 'string' ? input.slug.trim().toLowerCase() : '';
    if (!slug) return { ok: false, why: 'slug gerekli' };
    const isolation = input?.isolation === 'worktree' ? 'worktree' : input?.isolation === 'off' ? 'off' : null;
    if (!isolation) return { ok: false, why: "isolation 'worktree' ya da 'off' olmalı" };
    const branch = typeof input?.defaultBranch === 'string' && input.defaultBranch.trim()
      ? input.defaultBranch.trim() : 'dev';
    // Dal adı git gramerinden geçmeli — bozuk bir hedef merge anında patlardı.
    const refErr = branchName.refFormatError(branch);
    if (refErr) return { ok: false, why: `varsayılan dal geçersiz: ${refErr}` };

    const s = agentSettings.readSettings();
    const nextMap = { ...(s.projectIsolation && typeof s.projectIsolation === 'object' ? s.projectIsolation : {}) };
    nextMap[slug] = isolation;
    const applied = agentSettings.applySettingsPatch({ projectIsolation: nextMap });

    // Varsayılan dal defterde yaşar ve defter YOL İSTER (göreli yol iki cwd'de iki
    // şeydir). Repo çözülemiyorsa dal yazılamaz — bunu SÖYLERİZ, sessizce yutmayız.
    const repo = projectRepos.resolveProjectRepo(slug, agentWorkspaceRoot, {
      settings: applied.next, store: worktreeStore, homedir: crewpaneHome(), log: logLine,
    });
    let branchSaved = false;
    if (repo) {
      try {
        branchSaved = worktreeStore.setProject(slug, { repoPath: repo.repoPath, defaultBranch: branch }, crewpaneHome()) === true;
      } catch (e) {
        logLine(`project:config:set defterine yazılamadı (${slug}): ${e.message}`);
      }
    }
    logLine(`proje ayarı: ${slug} izolasyon=${isolation} dal=${branch}${repo ? ` repo=${repo.repoPath}` : ' repo=YOK'}`);
    return {
      ok: true,
      persisted: applied.persisted !== false,
      persistError: applied.persistError || null,
      branchSaved,
      repoPath: repo ? repo.repoPath : null,
      why: repo ? null : 'bu proje için git deposu bulunamadı — izolasyon açıkken görev spawn edilemez (H-5)',
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CIDX-1 — KOD İNDEKSİ KÖPRÜSÜ (Ayarlar → Hafıza & arama → "Kod indeksi")
  // ═══════════════════════════════════════════════════════════════════════════
  // Üç çağrı, üçü de SIRSIZ: bu MCP %100 yereldir, anahtar istemez (CODE-INDEX-R1
  // §6) → `credentialVault` yoluna hiç girmez. Köprüden yalnız SLUG geçer; ikilinin
  // ve deponun YOLUNU main çözer (G-1 — renderer yol dayatamaz).
  //
  // ⚠️ Anahtar VARSAYILAN KAPALI ve bu bir ölçümdür, tercih değil — ama gerekçesi
  // 09.09'da değişti (CODEINDEX-PROOF-01 §4): "her turda ≈5.300 jeton + oturumların
  // %29'unda amorti" ölçülmemiş bir tahmindi; gerçek yük 216 jeton/tur. Kapalı kalma
  // sebebi artık DEĞER: A/B'de araçlar kendiliğinden çağrılmadı, doğruluk değişmedi.
  // Bu yüzden "hepsini aç" düğmesi YOKTUR.
  ipcMain.handle('codeIndex:list', async (_e, input) => {
    const wanted = Array.isArray(input?.slugs)
      ? input.slugs.map((x) => codeIndexStore.projectKey(x)).filter(Boolean) : [];
    const s = agentSettings.readSettings();
    const map = (s && s.codeIndex && typeof s.codeIndex === 'object') ? s.codeIndex : {};
    const repoMap = (s && s.projectRepos && typeof s.projectRepos === 'object') ? s.projectRepos : {};
    let stored = {};
    try { stored = worktreeStore.listProjects(crewpaneHome()) || {}; } catch { stored = {}; }
    const slugs = [...new Set([...wanted, ...Object.keys(map), ...Object.keys(repoMap), ...Object.keys(stored)])]
      .map((x) => codeIndexStore.projectKey(x)).filter(Boolean).sort();
    const bin = (() => { try { return codeIndexStore.findBinary({ env: process.env }); } catch { return null; } })();
    // CODEINDEX-PROOF-01 — SAĞLIK ARACIN KENDİSİNDEN SORULUR (defter yeterli değil).
    // 09.09'da ölçüldü: crewpane indeksi (91.080 düğüm) çalışma ortasında bozuldu,
    // `.db.corrupt`a döndü ve projeden düştü — defter ise hâlâ "taze" diyordu.
    // `cli list_projects` 0,56 sn sürüyor (ölçüldü) ve bu çağrı zaten Ayarlar
    // açılışında bir kez koşuyor. Patlarsa `null` → "soramadım", KAYIP DEĞİL.
    //
    // 🪤 spawnSync KULLANILMAZ. İlk yazımda öyleydi ve yanlıştı: main süreci
    // Electron'un TEK UI iş parçacığıdır — orada senkron beklemek, ikili yavaş
    // ya da asılıysa uygulamanın TAMAMINI dondurur (zaman aşımı kadar). Sağlık
    // satırı bir konfor bilgisidir; uğruna pencere kilitlenmez. Asenkron okunur,
    // 5 sn'de cevap gelmezse "soramadım" (null) denir ve ekran bunu SÖYLER.
    const toolProjects = await new Promise((resolve) => {
      if (!bin) { resolve(null); return; }
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const child = require('node:child_process').spawn(bin.path, ['cli', 'list_projects', '{}'],
          { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        child.stdout.on('data', (d) => { if (out.length < 8 * 1024 * 1024) out += d; });
        child.on('error', () => finish(null));
        child.on('close', () => finish(codeIndexHealth.parseProjects(out)));
        setTimeout(() => { try { child.kill(); } catch { /* zaten indi */ } finish(null); }, 5000).unref();
      } catch { finish(null); }
    });
    const corrupt = codeIndexHealth.corruptNames(codeIndexHealth.defaultCacheDir());
    const injections = (() => { try { return codeIndexStore.injectionsThisSession(); } catch { return {}; } })();
    return {
      ok: true,
      // İkili YOKSA bu bir HATA DEĞİLDİR: ürün 262 MB'lık ikiliyi GÖMMEZ (§12.1).
      // UI bunu anlatır ve anahtarı pasif bırakır — ölü bir özellik gibi görünmesin.
      installed: !!bin,
      binPath: bin ? bin.path : null,
      binName: codeIndexStore.BIN_NAME,
      installUrl: codeIndexStore.INSTALL_URL,
      // WIN-PARITY-01 — kurulum KOMUTU platforma göre; Windows'ta `curl … | bash`
      // göstermek çalışmayacak bir komut vermekti (ENG-13'ün kapattığı sınıf).
      installHint: codeIndexStore.installHint(process.platform),
      platform: process.platform,
      serverName: codeIndexStore.SERVER_NAME,
      // ANAHTARIN SINIRI (CIDX-1 sürüşünde ÖLÇÜLDÜ): kullanıcının kendi
      // `~/.claude.json`'ında zaten bir kayıt varsa araçlar anahtar KAPALIYKEN de
      // pane'e girer. Ürün onu kapatamaz (kullanıcının yapılandırması onundur) —
      // ama SÖYLEYEBİLİR. Söylemezse kapalı anahtarın yanındaki araç listesi
      // "ayar çalışmıyor" diye okunur.
      userRegistered: (() => { try { return codeIndexStore.userRegisteredServers({}); } catch { return []; } })(),
      projects: slugs.map((slug) => {
        const rec = map[slug] || null;
        const repoPath = codeIndexRepoPath(slug);
        const fresh = codeIndexFreshness(repoPath, rec ? rec.indexedSha : null);
        // Defter + aracın gerçeği yan yana. `health.state` defterinkini EZEBİLİR
        // (missing/corrupt) — ama yalnız araca gerçekten sorabildiysek.
        // 🪤 YOL EŞLEŞTİRMESİ REALPATH İSTER: araç `root_path`i çözülmüş yazar,
        // bizim yolumuz sembolik bağ ya da `/tmp`→`/private/tmp` gibi bir takma ad
        // olabilir. Ham karşılaştırma, VAR olan bir indeksi "kayboldu" ilan ederdi.
        const realRepoPath = (() => {
          if (!repoPath) return repoPath;
          try { return require('node:fs').realpathSync(repoPath); } catch { return repoPath; }
        })();
        const health = codeIndexHealth.healthFor({
          repoPath: realRepoPath,
          ledger: {
            indexedSha: rec ? rec.indexedSha : null,
            lastIndexedAt: rec ? rec.lastIndexedAt : null,
            enabled: !!(rec && rec.enabled === true),
          },
          ledgerState: fresh.state,
          tool: toolProjects,
          corrupt,
        });
        return {
          slug,
          repoPath,
          enabled: !!(rec && rec.enabled === true),
          indexedSha: rec ? rec.indexedSha : null,
          lastIndexedAt: rec ? rec.lastIndexedAt : null,
          state: health.state,
          staleFiles: fresh.staleFiles,
          indexing: codeIndexJobs.has(slug),
          // SAĞLIK SATIRI — "nasıl anlayacağız?" sorusunun kalıcı cevabı.
          symbols: health.symbols,
          graphEdges: health.edges,
          toolAsked: health.toolAsked,
          toolName: health.toolName,
          injectedThisSession: injections[slug] || 0,
        };
      }),
    };
  });

  // Anahtarı çevir. REPLACE disiplini (projectIsolation emsali): harita bütün olarak
  // yazılır, yarım birleşmiş bir kayıt "kapattım sanıyordum" sınıfı sessiz bir açık
  // kol bırakmaz — bu ayar her turda para yakar.
  ipcMain.handle('codeIndex:set', (_e, input) => {
    const slug = codeIndexStore.projectKey(input?.slug);
    if (!slug) return { ok: false, why: 'proje kimliği gerekli' };
    const enabled = input?.enabled === true;
    const s = agentSettings.readSettings();
    const next = { ...(s.codeIndex && typeof s.codeIndex === 'object' ? s.codeIndex : {}) };
    const prev = next[slug] || {};
    next[slug] = { enabled, indexedSha: prev.indexedSha || null, lastIndexedAt: prev.lastIndexedAt || null };
    const applied = agentSettings.applySettingsPatch({ codeIndex: next });
    logLine(`kod indeksi: ${slug} → ${enabled ? 'AÇIK' : 'kapalı'} (bir sonraki pane'den itibaren)`);
    return {
      ok: true,
      enabled,
      persisted: applied.persisted !== false,
      persistError: applied.persistError || null,
      // Açık pane'ler ETKİLENMEZ: MCP argv spawn anında bağlanır. Bunu SÖYLERİZ,
      // yoksa kullanıcı açık pane'de aracı arar ve "çalışmıyor" der.
      restartHint: true,
    };
  });

  // "Şimdi indeksle" — ARKA PLANDA. İkili tek koşumda dakikalar sürebilir; invoke'u
  // beklemek Ayarlar penceresini kilitlerdi. İlerleme `codeIndex:progress` ile
  // itilir, sonuç defterimize (settings.codeIndex[slug].indexedSha) yazılır.
  // Sha'yı BİZ yazıyoruz çünkü aracın kendi `index_status`'ı indeksin sha'sını
  // BİLMİYOR (CIDX-0 §3.2) — tazelik başka türlü ölçülemez.
  ipcMain.handle('codeIndex:index', (_e, input) => {
    const slug = codeIndexStore.projectKey(input?.slug);
    if (!slug) return { ok: false, why: 'proje kimliği gerekli' };
    if (codeIndexJobs.has(slug)) return { ok: false, why: 'bu proje zaten indeksleniyor' };
    const bin = (() => { try { return codeIndexStore.findBinary({ env: process.env }); } catch { return null; } })();
    if (!bin) return { ok: false, why: `${codeIndexStore.BIN_NAME} kurulu değil` };
    const repoPath = codeIndexRepoPath(slug);
    if (!repoPath) return { ok: false, why: 'bu proje için git deposu bulunamadı' };
    const headSha = (() => {
      try {
        return require('node:child_process')
          .execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 4000 }).trim();
      } catch { return null; }
    })();
    const push = (payload) => {
      if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('codeIndex:progress', { slug, ...payload });
    };
    let child;
    try {
      child = spawn(bin.path, ['cli', 'index_repository', '--repo-path', repoPath], {
        cwd: repoPath, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { ok: false, why: `indeksleme başlatılamadı: ${e.message}` };
    }
    codeIndexJobs.set(slug, child);
    logLine(`kod indeksi: ${slug} indeksleniyor (${repoPath})`);
    let tail = '';
    const onOut = (buf) => { tail = (tail + buf.toString()).slice(-2000); push({ running: true }); };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);
    child.on('error', (e) => { logLine(`kod indeksi: ${slug} hata ${e.message}`); });
    child.on('close', (code) => {
      codeIndexJobs.delete(slug);
      const ok = code === 0;
      if (ok && headSha) {
        try {
          const cur = agentSettings.readSettings();
          const map = { ...(cur.codeIndex && typeof cur.codeIndex === 'object' ? cur.codeIndex : {}) };
          const prev = map[slug] || {};
          map[slug] = { enabled: prev.enabled === true, indexedSha: headSha, lastIndexedAt: Date.now() };
          agentSettings.applySettingsPatch({ codeIndex: map });
        } catch (e) { logLine(`kod indeksi: ${slug} defteri yazılamadı (${e.message})`); }
      }
      logLine(`kod indeksi: ${slug} bitti çıkış=${code}`);
      push({ running: false, ok, exitCode: code, tail: ok ? null : tail.slice(-400) });
    });
    return { ok: true, started: true, repoPath };
  });

  ipcMain.handle('settings:get', () => {
    const s = agentSettings.readSettings();
    return {
      ok: true,
      workspaceRoot: s.workspaceRoot,
      resolvedWorkspaceRoot: agentWorkspaceRoot, // ADP-232-C — null = paketli + ilk kurulum yapılmadı
      // ADP-852 v3 — Ayarlar→Genel ARTIK ham dizeyi tek başına göstermiyor. `workspaceRoot`
      // dolu + `resolvedWorkspaceRoot` null kombinasyonu kullanıcıya "her şey yolunda" gibi
      // görünüyordu (Sistem Durumu ise kırmızıydı). Bu alan o sessiz çelişkiyi ekrana taşır.
      workspaceRootProblem: (() => {
        const st = agentSettings.configuredWorkspaceRootStatus();
        return st.root ? null : { reason: st.reason, configured: st.configured, code: st.code ?? null };
      })(),
      repoRoot: REPO_ROOT,
      // ADP-232-C — ilk-açılış gate sinyali + karşılama ekranının önerilen varsayılanı.
      // firstRunRequired canlı hesaplanır (settings:set sonrası tekrar sorulursa false
      // döner — restart beklenirken gate'in geri gelmemesi bu alana bakar).
      firstRunRequired: workspaceOnboarding.firstRunRequired({ isPackaged: app.isPackaged }),
      defaultWorkspaceDir: workspaceOnboarding.defaultWorkspaceDir(),
      pushToTalkKey: s.pushToTalkKey,
      pushToTalkKeys: agentSettings.PUSH_TO_TALK_KEYS,
      wakeModelPath: s.wakeModelPath,
      keepExitedPanes: s.keepExitedPanes === true, // ADP-303 — dead pane auto-close opt-out
      // ENG-HONEST-CARD-01 — motor politikaları ({ <id>: { vendorHosted:'allow'|'block' } }); sır değil.
      engines: s.engines || {},
      // HATA-07 — "Görev sınıfına göre otomatik model" (varsayılan KAPALI). Bu satır
      // ŞART: yoksa kullanıcı anahtarı açar, diske yazılır ama panel/delegasyon bir
      // daha OKUYAMAZ (ADP-675/717/845'te ölçülen aynı beyaz-liste tuzağı).
      autoModelByTaskClass: s.autoModelByTaskClass === true,
      // LDR-F1 — lider oturumunun otomatik tazeleme kipi ('off'|'warn'|'auto').
      // Hüküm main'de normalize edilir: renderer çöp bir değeri geri yazamaz.
      leaderAutoRefresh: leaderRefreshPolicy.normalizeMode(s.leaderAutoRefresh),
      cloudSyncEnabled: s.cloudSyncEnabled === true, // SYNC-F1-6 — bulut senkronu opt-in (varsayılan KAPALI)
      // SYNC-F1-7 — tercih projeksiyonu (varsayılan AÇIK). Beyaz liste ŞART: yoksa
      // kullanıcı kolu kapatır, diske yazılır ama bir daha OKUNMAZ (ADP-675 tuzağı).
      prefsSyncEnabled: s.prefsSyncEnabled !== false,
      paneZoomShortcut: s.paneZoomShortcut ?? null, // ADP-558 — pane zoom kısayolu (null = varsayılan)
      paneMoveShortcut: s.paneMoveShortcut ?? null, // KEY-01 — yerleştirme ailesinin modifier tabanı (null = varsayılan)
      terminalFontScale: s.terminalFontScale || 'medium', // ADP-663 — terminal/okuyucu yazı ölçeği
      // ADP-888 — ARAYÜZ DİLİ: kullanıcının TERCİHİ ('system'|'tr'|'en') + o tercihin
      // bu makinede ÇÖZÜLMÜŞ hâli. İkisi ayrı gider çünkü Ayarlar ekranı "Sistem"
      // seçiliyken bile hangi dilin geçerli olduğunu göstermek zorundadır (ADP-620
      // updateChannel/updateChannelEffective ile aynı çift).
      locale: s.locale || 'system',
      localeEffective: appI18n.getLocale(),
      // ADP-885 Faz B (ADR-VOICE-LOCALE) — SES DİLİ: ARAYÜZ DİLİNDEN AYRI eksen.
      // Aynı tercih/etkin çifti: Ayarlar "Arayüzü izle" seçiliyken bile hangi dilde
      // dinlendiğini göstermek zorunda. Çözümü renderer YAPMAZ (ikinci gerçek olurdu).
      voiceLocale: s.voiceLocale || 'follow-ui',
      voiceLocaleEffective: appI18n.voiceLocale(s),
      // HAND-A1 — "El kontrolü" overlay tercihi (kapalı-liste nöbetinden geçmiş;
      // Ayarlar ekranı HAND-A3'te bu alana bağlanır).
      handControl: handOverlayContract.sanitizeHandControl(s.handControl),
      updateAutoCheck: s.updateAutoCheck !== false, // ADP-533 — otomatik güncelleme kontrolü toggle'ı
      // ADP-907 — "yabancı kanca" kartı kapatıldı mı (kart bunu okur, Ayarlar geri açar).
      foreignHookNoticeDismissed: s.foreignHookNoticeDismissed === true,
      // ADP-945 — tanıtım turu bitirildi/atlandı mı. Bu satır ŞART (aynı beyaz-liste
      // tuzağı: ADP-675/717/845). Yoksa `settings:set` bayrağı diske YAZAR ama
      // ProductTour bir daha OKUYAMAZ → tur her açılışta yine gelir ve düzeltme
      // "yapıldı ama işe yaramadı" gibi görünür.
      productTourDone: s.productTourDone === true,
      // TOUR-02-GUIDE-PERSIST — Rehber turu bitirildi mi. AYNI şartın İKİNCİ
      // KAPISI: `agentSettings` okuma beyaz-listesine eklemek YETMİYOR, çünkü
      // renderer ayarı buradan (settings:get PROJEKSİYONU) okur. e2e'de ÖLÇÜLDÜ:
      // bayrak settings.json'da `true` iken bile Rehber ikinci açılışta geri geldi,
      // çünkü bu satır yoktu ve `settingsApi().get()` anahtarı hiç taşımıyordu.
      onboardingGuideDone: s.onboardingGuideDone === true,
      // ADP-715/845 — telemetri OPT-OUT anahtarı. Bu satır ŞART: yoksa kullanıcı
      // kapatır, ayar diske yazılır ama panel bir daha OKUYAMAZ → "kapattım ama
      // hâlâ açık görünüyor" (ADP-675/717'de ölçülen aynı beyaz-liste tuzağı).
      telemetryEnabled: s.telemetryEnabled !== false,
      // ADP-620 — yayın kanalı: kullanıcının AÇIK tercihi ('auto'|'stable'|'beta') +
      // o tercihin bu instance'ta ÇÖZÜLMÜŞ hâli (toggle'ın işaretli görüneceği değer).
      updateChannel: updateChannel.normalizeChannel(s.updateChannel) || 'auto',
      updateChannelEffective: currentUpdateChannel(),
      hasOpenAiKey: !!(s.apiKeys && s.apiKeys.openai),
      // ADP-827 — xAI anahtarı VAR mı (sır DÖNMEZ). Ayarlar'daki "Grok Voice"
      // seçeneğinin gri mi aktif mi olacağını bu bayrak belirler.
      hasXaiKey: !!(s.apiKeys && s.apiKeys.xai),
      // ADP-580/595 — codex custom AI providers (Groq/DeepSeek/Kimi): BYOK key entry
      // (Ayarlar) + ajan formunun sağlayıcı/model seçicisi. Tek kaynak providers.cjs.
      aiProviders: aiProvidersPayload(s),
      // AGENT-MODEL-01 — motor başına MODEL kataloğu + EFOR kümesi (ajan formu).
      // aiProviders'tan AYRI: o codex'in ALTINDAKİ sağlayıcıların modelleri, bu ise
      // MOTORUN KENDİ modelleri (claude alias'ları / codex'in kendi kataloğu).
      engineModels: engineModelCatalogPayload(),
      // SKL-B3 (K-8) — ürünün KENDİ API anahtarları (Gemini). aiProviders'tan AYRI
      // liste: bunlar motor/pane değil, ürünün kendi çağrılarıdır. Sır DÖNMEZ.
      appApiKeys: appApiKeysPayload(),
      mcpServers: s.mcpServers,
      jarvis: s.jarvis,
      // ADP-854B — DİNLEME EŞİKLERİNİN ÇÖZÜLMÜŞ hâli. `jarvis` ham ayarı taşır
      // (null = "varsayılan"), panel ise EKRANDA bir sayı göstermek zorunda —
      // o sayıyı renderer'ın uydurması ikinci bir gerçek demekti (ADP-812 dersi).
      // Üçü de aynı normalize kapısından geçer, yani panelde gördüğün değer
      // çalışma anında UYGULANAN değerdir.
      jarvisEndpoint: {
        silenceMs: jarvisVoice.normalizeSilenceMs(s.jarvis && s.jarvis.silenceMs),
        endpointMaxMs: jarvisVoice.normalizeEndpointMaxMs(
          s.jarvis && s.jarvis.endpointMaxMs,
          s.jarvis && s.jarvis.silenceMs,
        ),
        sleepAfterMs: jarvisVoice.normalizeSleepAfterMs(s.jarvis && s.jarvis.sleepAfterMs),
        // ADP-916 — panel de UYGULANAN "hiç konuşulmadı" eşiğini görsün.
        noSpeechMs: jarvisVoice.normalizeNoSpeechMs(s.jarvis && s.jarvis.noSpeechMs),
        // AGENTX-WAKE-01 — panel uyku türünü de gösterir/değiştirir.
        silentSleep: !!(s.jarvis && s.jarvis.silentSleep === true),
      },
      // ADP-827 — ses modu + Grok kataloğu/fiyatı. Fiyat sayısı RENDERER'DA
      // TUTULMAZ, main PUSH eder (ADP-614 dersi: etiketleri renderer tutarsa
      // sessizce bayatlar). `voiceMode` de burada çözülür — panelin kendi
      // fail-safe kuralını yazması iki gerçek demek olurdu.
      voiceMode: grokVoice.resolveVoiceMode(s),
      grok: {
        model: grokVoice.resolveGrokModel(s),
        voice: grokVoice.resolveGrokVoice(s),
        voices: grokVoice.GROK_VOICES,
        models: Object.values(grokVoice.GROK_MODELS),
        cost: grokVoice.grokCostNotice(grokVoice.resolveGrokModel(s)),
        pricingSource: grokVoice.GROK_PRICING_SOURCE,
      },
      // ADP-848 — TTS sağlayıcı katmanı (motorlar + anahtar bayrakları + DÜRÜST
      // maliyet + Türkçe önizleme cümlesi). SIR DÖNMEZ. Aynı sözleşme jarvis:config
      // üzerinden de gider; iki yüzey de TEK kaynaktan (ttsProviders.ttsConfig) okur.
      tts: jarvisVoice.ttsProviders.ttsConfig(s, { rootDir: REPO_ROOT }),
      // ADP-915 — "Motorlar & Maliyet": her yetenek (beyin/ses tanıma/seslendirme)
      // için hangi motor SEÇİLİ, ücretsiz mi, hangi anahtarı ister, fatura kime
      // çıkar. SIR DÖNMEZ (yalnız var/yok bayrağı). Renderer bu listeyi ÇİZER —
      // motor adlarını/varsayılanlarını kendisi YAZMAZ, yoksa yarın bir motor
      // eklendiğinde ekran sessizce yalan söylerdi (ADP-614 dersi).
      engineCost: engineCatalog.engineCostSummary(s, {
        rootDir: REPO_ROOT,
        // Ücretsiz yerel STT GERÇEKTEN kurulu mu — ekran iddia etmesin, ÖLÇSÜN.
        sttStatus: jarvisVoice.whisperLocal.status({ settings: s }),
      }),
      theme: s.theme, // ADP-258 — durable theme pref (renderer reconciles → localStorage)
      // ADP-304 — ekran (toast) filtreleri; sır değil, renderer doğrudan okur.
      notifications: s.notifications,
      // ADP-343 (ADR-026 §2.5) — güven ayarı + YERLEŞİK listeler. Yerleşikler salt-okunur:
      // renderer onları yalnız GÖSTERİR (kullanıcı localhost'u güvenilirlikten çıkaramaz,
      // prod paneli/ödeme sitesini yasaktan çıkaramaz — güvenli varsayılan koddadır).
      // Yasak desenlerin `path` regex'i JSON'a geçmez → okunur metne çevrilir.
      browserTrust: s.browserTrust,
      // ADP-717 — takım kapsamı izinleri (Ayarlar → Takım İzinleri). `readSettings`
      // BEYAZ LİSTE olduğu için bu satır ŞART: yoksa izin diske yazılır ama panel onu
      // bir daha OKUYAMAZ (kullanıcı "izin verdim, hâlâ kapalı" görürdü).
      // ADP-737 — burası bir GÖSTERİM okumasıdır: mandalı ÇAKMAZ. Ayarlar penceresini
      // açmak "kural yürürlüğe girdi" demek değildir; mandalı yalnız gerçek bir yetki
      // kararı çakar (ensureTeamScopeMandate). Aksi hâlde damga yine gerçek kullanımın
      // önüne geçer — düzeltilen mayının aynısı.
      teamScope: teamScope.sanitizeTeamScope(agentSettings.readSettings().teamScope),
      browserTrustBuiltins: {
        trusted: [...browserTrustMod.BUILTIN_TRUSTED],
        blocked: browserTrustMod.BUILTIN_BLOCKED.map((r) => ({
          host: r.host,
          why: r.why,
          path: r.path ? String(r.path) : null,
        })),
      },
    };
  });
  ipcMain.handle('settings:set', (_event, patch) => {
    // ADP-232 — apply + restart-compare live in agentSettings.applySettingsPatch
    // so "same value saved again → no restart" is unit-tested, not just hoped.
    const { next, restartRequired, persisted, persistError } = agentSettings.applySettingsPatch(patch);
    // ADP-946 — `ok:true` yazımın DİSKE indiğini söylemiyordu (yalnız "kabul edildi").
    if (persisted === false) logLine(`settings:set DİSKE YAZILAMADI (${persistError}) — patch: ${Object.keys(patch || {}).join(',')}`);
    // ADP-888 — dil değiştiyse ÜÇ tüketici de aynı anda tazelenir: main'in kendi
    // diyalogları, açık pencereler (canlı push) ve bundan sonra doğacak pencereler
    // (argv bayrağı applyAppLocale'i yeniden okur). RESTART GEREKMEZ ve route
    // değişmez — açık pane/terminal durumu yaşar (ADP-885 §3.1 kararının bedeli budur).
    const localeState = patch && 'locale' in patch ? broadcastLocale() : null;
    // SYNC-F1-6 — senkron tercihi bu patch'te değiştiyse motor ANINDA çözülür:
    // kapatma yeniden başlatma beklemez (opt-in'i geri almanın yarım kalması,
    // §5.3'ün şifrelenmemiş saklama sınırıyla birlikte kabul edilemez).
    if (patch && 'cloudSyncEnabled' in patch) {
      try { syncRuntime.refresh({ tickNow: next.cloudSyncEnabled === true }); }
      catch (e) { logLine(`[sync] tercih uygulanamadı: ${e.message}`); }
    }
    // SYNC-F1-7 — HER ayar yazımından sonra projeksiyon tazelenir. Hangi anahtarın
    // taşınabilir olduğuna BURASI karar VERMEZ (beyaz liste karar verir); burada
    // yalnız "bir şey değişti" sinyali vardır. Projeksiyon idempotenttir:
    // taşınabilir bir anahtar değişmediyse dosya baytı DEĞİŞMEZ, senkron uyanmaz.
    prefsProjectNow('settings:set');
    // HAND-A1 — overlay tercihi ANINDA uygulanır (görev kartı madde 3): kapatma
    // açık pencereleri o an indirir, yoğunluk açık pencerelere canlı gider.
    if (patch && 'handControl' in patch) {
      try { applyHandOverlaySettings(); }
      catch (e) { logLine(`hand overlay: tercih uygulanamadı: ${e.message}`); }
    }
    return {
      ok: true,
      workspaceRoot: next.workspaceRoot,
      locale: next.locale,
      localeEffective: localeState ? localeState.locale : appI18n.getLocale(),
      // ADP-885 Faz B — ses dili KAYITTAN SONRA yeniden çözülür. İki yoldan da
      // değişebilir: kullanıcı ses dilini seçti YA DA arayüz dilini değiştirdi ve
      // ses "Arayüzü izle"de. İkincisi bu satır olmadan ekranda bayat kalırdı.
      voiceLocale: next.voiceLocale,
      voiceLocaleEffective: appI18n.voiceLocale(next),
      pushToTalkKey: next.pushToTalkKey,
      wakeModelPath: next.wakeModelPath,
      hasOpenAiKey: !!(next.apiKeys && next.apiKeys.openai),
      hasXaiKey: !!(next.apiKeys && next.apiKeys.xai), // ADP-827 — kaydettikten sonra rozet tazelensin
      // ADP-580 — refreshed provider-key presence after a BYOK save (secret-safe).
      aiProviders: aiProvidersPayload(next),
      engineModels: engineModelCatalogPayload(), // AGENT-MODEL-01
      // SKL-B3 — kaydettikten SONRA rozet + KAYNAK tazelensin: kullanıcı "artık
      // Ayarlar'dan geliyor" cümlesini kaydın hemen ardından görmeli (keys.env'den
      // Ayarlar'a geçişin görünür olması K-8'in yarısıdır).
      appApiKeys: appApiKeysPayload(),
      // ADP-234 — agentWorkspaceRoot is resolved ONCE at module load (spawn cwd,
      // bridge results dir, embedded-server env all hang off it); a changed
      // workspaceRoot only takes effect after an app restart. Deliberately
      // restart-gated (no live rehydration): three independent consumers would
      // otherwise drift on a half-applied change. The renderer surfaces this flag
      // as a "restart to apply" notice.
      restartRequired,
      // ADP-946 — yazım gerçekten diske indi mi (geri okunmuş hüküm). `false` ise
      // ayar bu oturumda geçerlidir ama yeniden açılışta KAYBOLUR.
      persisted,
      persistError,
    };
  });
  // ADP-737 — TAKIM KAPSAMI KAPISI, renderer ucu. Delegasyon rosterı renderer'da
  // çözülür (roster + kimlik Supabase'ten gelir), dolayısıyla "bu worker hangi TAKIMIN
  // çalışanı" bilgisi orada oluşur. Karar yine MAIN'de: burada yalnız sorulur.
  // `manage` de kabul edilir ki gelecekte aynı kapı UI'dan da sorulabilsin.
  ipcMain.handle('teamScope:authorize', async (_event, req) => {
    const p = req && typeof req === 'object' ? req : {};
    const action = p.action === 'manage' ? 'manage' : 'delegate';
    const leaderId = typeof p.leaderId === 'string' ? p.leaderId.trim() : '';
    const targetScope = typeof p.targetScope === 'string' ? p.targetScope.trim() : '';
    if (!leaderId || !targetScope) return { ok: false, code: 'bad-request', reason: 'leaderId + targetScope gerekli' };
    try {
      const d = await authorizeTeamScopeInteractive({ action, leaderId, targetScope });
      return { ok: d.ok === true, via: d.via || null, code: d.code || null, reason: d.reason || null };
    } catch (err) {
      // Kapı KARAR VEREMİYORSA iş başlamamalı (fail-closed) — sebebi log'a düşer.
      logLine(`teamScope:authorize hata: ${String((err && err.message) || err)}`);
      return { ok: false, code: 'gate-error', reason: String((err && err.message) || err) };
    }
  });
  // ADP-232-C — ilk-açılış "çalışma alanı seç" aksiyonları. Yol renderer'dan ASLA
  // gelmez (ADP-103 capability modeli): 'create' sabit önerilen varsayılanı
  // (~/CrewPane) oluşturur, 'pick' yolu OS dialog'undan alır. Her iki yol da
  // commitWorkspaceRoot'tan geçer → bundle-içi kök NET hatayla reddedilir
  // (inside-app-bundle) ve settings.workspaceRoot yazımı restartRequired döner
  // (ADP-232 Faz A tek-tık relaunch'ı renderer tetikler).
  ipcMain.handle('workspace:provision', async (event, req) => {
    const mode = req && typeof req === 'object' ? req.mode : null;
    const forbiddenPrefix = app.isPackaged ? process.resourcesPath : null;
    // BL-01 — paket tavanı BURADA da: 'create' önerilen ~/CrewPane'i, 'pick'
    // seçilen klasörü BENİMSER; ikisi de "yeni çalışma alanı"dır. İlk kurulumda
    // sayım 0'dır → hiçbir katman ilk alanını açmaktan alıkonmaz.
    const planReject = (denial) => {
      logLine(`workspace:provision REDDEDİLDİ (plan): ${denial.tier} tavan=${denial.limit} kullanım=${denial.current}`);
      return { ok: false, reason: 'plan_limit', error: denial.message, title: denial.title,
        limit: denial.limit, current: denial.current, tier: denial.tier,
        requiredTier: denial.requiredTier, action: 'upgrade' };
    };
    if (mode === 'create') {
      const gate = workspacePlanDenial(workspaceOnboarding.defaultWorkspaceDir());
      if (gate) return planReject(gate);
      const res = workspaceOnboarding.provisionDefaultWorkspace({ forbiddenPrefix });
      logLine(`workspace:provision create → ${res.ok ? res.root : `FAIL ${res.reason}`}`);
      if (res.ok) rememberWorkspaceRoot(res.root);
      return res;
    }
    if (mode === 'pick') {
      const win = BrowserWindow.fromWebContents(event.sender);
      let result;
      try {
        result = await dialog.showOpenDialog(win ?? undefined, {
          title: appI18n.t('main.dialog.chooseWorkspace.title'),
          buttonLabel: appI18n.t('main.dialog.chooseWorkspace.button'),
          properties: ['openDirectory', 'createDirectory'],
        });
      } catch (err) {
        return { ok: false, reason: 'dialog-failed', detail: err.message };
      }
      if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return { ok: false, reason: 'canceled' };
      }
      const gate = workspacePlanDenial(result.filePaths[0]);
      if (gate) return planReject(gate);
      const res = workspaceOnboarding.commitWorkspaceRoot(result.filePaths[0], { forbiddenPrefix });
      logLine(`workspace:provision pick → ${res.ok ? res.root : `FAIL ${res.reason}`}`);
      if (res.ok) rememberWorkspaceRoot(res.root);
      return res;
    }
    return { ok: false, reason: 'bad-mode' };
  });
  // ADP-232-B — CANLI çalışma alanı geçişi (yeniden başlatmadan). İlk-açılış
  // (workspace:provision) app'i relaunch ederdi; bu yol AÇIK bir kurulumu, çalışan
  // pane'ler/işler ölmeden yeni köke taşır. Yol yine renderer'dan gelmez: 'pick' OS
  // dialog'undan alır. ('current' modu Ayarlar'ın YAZDIĞI kökü, kullanıcının input'una
  // güvenen settings:set ile aynı sözleşmeyle, canlı uygular.)
  ipcMain.handle('workspace:switch', async (event, req) => {
    const mode = req && typeof req === 'object' ? req.mode : null;
    if (mode === 'pick') {
      const win = BrowserWindow.fromWebContents(event.sender);
      let result;
      try {
        result = await dialog.showOpenDialog(win ?? undefined, {
          title: appI18n.t('main.dialog.switchWorkspace.title'),
          buttonLabel: appI18n.t('main.dialog.chooseWorkspace.button'),
          properties: ['openDirectory', 'createDirectory'],
        });
      } catch (err) {
        return { ok: false, reason: 'dialog-failed', detail: err.message };
      }
      if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
        return { ok: false, reason: 'canceled' };
      }
      return switchWorkspaceRoot(result.filePaths[0]);
    }
    // 'current' — Ayarlar zaten settings.workspaceRoot'a yazdı; onu canlı uygula.
    if (mode === 'current') {
      const target = agentSettings.readSettings().workspaceRoot;
      if (!target) return { ok: false, reason: 'not-a-directory' };
      return switchWorkspaceRoot(target);
    }
    // Doğrudan yol (Ayarlar input'u — settings:set ile aynı güven sınırı).
    if (req && typeof req.root === 'string' && req.root.trim()) {
      return switchWorkspaceRoot(req.root.trim());
    }
    return { ok: false, reason: 'bad-mode' };
  });

  // B-06 — ONBOARDING ŞABLON ÖNERİSİ (ONBOARDING-PRESETS-SPEC §4.2). DAR kanal:
  // renderer serbest metni + ŞABLON KATALOĞUNU yollar, cevap yalnız o kataloğun
  // içinden bir id olabilir (presetAdvisor doğrular). Genel amaçlı "modele sor"
  // kanalı BİLEREK açılmadı — bu kanal başka hiçbir şeye yaramaz.
  ipcMain.handle('presets:recommend', async (_event, payload) => {
    const req = payload || {};
    return presetAdvisor.recommendWithClaude({
      text: req.text,
      presets: Array.isArray(req.presets) ? req.presets : [],
      locale: req.locale === 'en' ? 'en' : 'tr',
      // ÖLÇÜLEBİLİRLİK DİKİŞİ: e2e hem BAŞARILI hem BAŞARISIZ modeli deterministik
      // koşabilsin diye ikili yolu dışarıdan verilebilir. Ürün yolunda değişken
      // yoktur → motor kaydının kendisi (engineCatalog) kullanılır. Bu dikiş
      // olmadan "model hatasında varsayılan preset görünüyor" iddiası ancak
      // makinede claude'u SİLEREK kanıtlanabilirdi.
      claudeBin: process.env.CREWPANE_PRESET_ADVISOR_BIN || engineCatalog.BRAIN_CLI,
      // GUI süreçlerinin budanmış launchd PATH'i `claude`ı bulamaz (agentRunner
      // ile aynı düzeltme; jarvisVoice.decideWithClaude da bunu kullanıyor).
      env: { ...process.env, PATH: agentRunner.augmentedPath(process.env.PATH) },
    });
  });


  // ADP-139 (DOGFOOD Engel #2) — self-host dev affordances.
  //  • app:info        → { mode, packaged, rebuildSupported } so the renderer can
  //                      render the right affordance (HMR badge in dev vs a
  //                      Rebuild button in prod-from-source).
  //  • app:rebuildRelaunch → run `npm run electron:build:prep` (FIXED args — no
  //                      renderer input → no RCE), stream progress, then relaunch
  //                      the app so a renderer change is picked up in ONE click.
  //                      Only when running from the source tree (not packaged):
  //                      a distributed .app has no source/npm to rebuild.
  ipcMain.handle('app:info', () => ({
    mode: MODE,
    packaged: app.isPackaged,
    rebuildSupported: !app.isPackaged,
    // ADP-171 — multi-tenant auth opt-in flag (read at runtime so e2e can launch
    // with CREWPANE_AUTH=1 without a rebuild). Absent/empty → AuthGate bypasses
    // (anon mode preserved). Truthy ('1'/'true') → magic-link AuthGate enforced.
    authEnabled: /^(1|true|on|yes)$/i.test(String(process.env.CREWPANE_AUTH || '')),
    // ADP-268 — shell identity for the header BuildBadge: version (packaged:
    // extraMetadata-injected package.json), instance (prod/dev/test) and the
    // shell's build commit to compare against the renderer bundle's.
    version: app.getVersion(),
    instance: instancePaths.instanceId(),
    commit: SHELL_COMMIT,
    // RESET-03 — BU AÇILIŞTA SIFIRLAMA UYGULANDI MI? Yalnız SAYI ve kapalı bir
    // `kind` kümesi taşır (yol/dosya adı/hata gövdesi YOK — resetGate.bootNotice).
    // Cümleyi gösteren yüzey kendi sözlüğünden yazar; null = sıfırlama olmadı.
    resetBoot: resetBootNotice,
  }));
  ipcMain.handle('app:rebuildRelaunch', (event) => rebuildAndRelaunch(event));

  // DEMO-04 — TANITIM TURUNUN ÖRNEK SİTESİ. Kurulumla gelen tek dosyalık statik
  // sayfanın `file:` adresini döner; tur onu gömülü tarayıcıda açar. Dosya yoksa
  // `{ ok:false }` — çağıran uydurma bir adrese gitmesin, sekmeyi hiç açmasın.
  // Renderer'dan gelen TEK girdi dil seçimidir ve KAPALI bir kümeye daraltılır
  // (yol renderer'dan HİÇ alınmaz → keyfi dosya açtırma yolu yok).
  ipcMain.handle('demo:siteUrl', (_event, payload) => {
    const lang = payload && payload.lang === 'en' ? 'en' : 'tr';
    const url = demoSitePath.demoSiteUrl({ lang });
    return url ? { ok: true, url } : { ok: false };
  });

  // ADP-463-B — setup sihirbazı motor/CLI kontrolü (uyarı-only, ASLA bloklamaz).
  // → { engines:[{id,name,found,path,installUrl}], anyFound }. Probe hata verirse
  // (shell yok/timeout) her motor "found:false" döner — adım yine de açılır.
  // ADP-694 — PANOYA YAZ (main tarafı). GERÇEK e2e'de ölçüldü: renderer'daki
  // `navigator.clipboard.writeText` Electron penceresi odakta değilken REDDEDİLİYOR
  // (kaplamadaki "Kopyala" hiçbir şey kopyalamıyordu, ekran görüntüsüyle kanıtlı).
  // Masaüstü uygulamasında doğru yol Electron'un kendi panosudur: izin/odak
  // gerektirmez. Renderer önce bunu dener, köprü yoksa navigator'a düşer.
  // GÜVENLİK: tek yön + yalnız düz metin + boy sınırı; pano OKUMA ucu YOK
  // (renderer'ın kullanıcının panosunu okumasına gerek yok, açmıyoruz).
  // ADP-894 — TAVAN 4096'DAN 1 MB'A. Bu uç artık TERMİNAL SEÇİMİNİ de kopyalıyor
  // (Terminal.tsx geri düşüşü); bir ekran dolusu çıktı 4096'ı rahat aşar ve eski
  // hâl `slice` edip yine `ok:true` dönüyordu — yani SESSİZ VERİ KAYBI. Artık
  // kırpma olursa çağırana `truncated` ile SÖYLENİR.
  const CLIPBOARD_MAX = 1024 * 1024;
  ipcMain.handle('clipboard:write', (_event, text) => {
    const raw = typeof text === 'string' ? text : '';
    const value = raw.slice(0, CLIPBOARD_MAX);
    if (!value) return { ok: false, reason: 'empty' };
    try {
      clipboard.writeText(value);
      return { ok: true, truncated: value.length < raw.length };
    } catch (err) {
      logLine(`clipboard:write failed: ${err.message}`);
      return { ok: false, reason: 'write-failed' };
    }
  });

  // ADP-894 — ODAKLI yüzeye YAPIŞTIR. Windows'ta terminal pane'inde Ctrl+V
  // xterm tarafından `\x16` (SYN) olarak yutuluyor ve HİÇBİR ŞEY yapışmıyordu
  // (gerçek Electron+xterm ölçümü); macOS'ta aynı işi varsayılan Edit menüsü
  // `webContents.paste()` ile görüyor. Renderer yalnız "yapıştır" DİYEBİLİR —
  // panoyu OKUYAMAZ (içerik main'den renderer'a geçmez).
  //
  // ADP-925 — MOTORUN KENDİ PANO-GÖRÜNTÜ YOLU. ÖLÇÜLDÜ (gerçek claude v2.1.223
  // TUI'si, e2e probe): claude ham `\x16` (Ctrl+V) baytını alınca sistem panosundaki
  // GÖRÜNTÜYÜ kendisi okur ve prompt kutusuna `[Image #1]` rozetini basar. Bir dosya
  // YOLU yapıştırmak AYNI ŞEY DEĞİLDİR — ölçüldü: yol düz metin olarak kutuda kalır,
  // rozet çıkmaz (ADP-035'in "yolu görünce [Image #N] yapar" varsayımı bugünün
  // CLI'ında GEÇERSİZ). Codex ÖLÇÜLMEDİ ⇒ tabloda YOK: ölçmediğimiz bir motoru
  // "destekliyor" saymak, kullanıcının pane'ine çöp kontrol karakteri yazmak olurdu.
  // WIN-IMG-01 — tablo artık PLATFORM × MOTOR ve `clipboardImageRoute.cjs`te
  // yaşıyor (saf + üç platform test edilir). Buradaki eski tek satırlık tablo
  // platformsuzdu ama ölçüm YALNIZ macOS'taydı: Windows'ta `\x16` pane'e iniyor
  // ve karşılığı olmayabiliyordu → kullanıcı için SESSİZ HİÇLİK (müşteri kanıtı).

  /**
   * WIN-IMG-01 — WINDOWS: Explorer'da bir görsele Ctrl+C basmak panoya BİTMAP
   * koymaz, DOSYA LİSTESİ koyar (CF_HDROP; Electron bunu `FileNameW` formatıyla
   * açar). Eski akışta `readImage()` boş + `readText()` boş ⇒ `webContents.paste()`
   * ⇒ hiçbir şey olmuyordu. Best-effort: format yoksa boş dizi.
   */
  function readClipboardFilePaths() {
    if (process.platform !== 'win32') return [];
    try {
      const formats = clipboard.availableFormats();
      if (!formats.includes('FileNameW')) return [];
      const buf = clipboard.readBuffer('FileNameW');
      if (!buf || !buf.length) return [];
      const s = buf.toString('ucs2').replace(/\0+$/g, '').trim();
      return s ? [s] : [];
    } catch (err) {
      logLine(`clipboard file-list read failed: ${err.message}`);
      return [];
    }
  }

  // ADP-925 — PANODAKİ GÖRÜNTÜ. `webContents.paste()` bir DÜZENLEME komutudur ve
  // yalnız METİN taşır: kullanıcı ekran görüntüsünü panoya alıp Ctrl+V'ye bastığında
  // HİÇBİR ŞEY olmuyordu (sürükle-bırak çalışıyor, pano çalışmıyordu — aynı ürünün
  // iki yolu ayrışmıştı). macOS'ta ⌘V hiç, Windows'ta ise ADP-894'ten BERİ hiç
  // çalışmıyordu: orada Ctrl+V artık metin-yapıştırmaya çevrildiği için claude'un
  // kendi `\x16` yolu da kapanmıştı.
  //
  // Karar burada verilir çünkü panoyu YALNIZ main okuyabilir; teslimi ise renderer
  // yapar (pty yazımı `pty:input`ten geçsin — ADP-667/692 tuş damgaları dürüst kalır):
  //   • pano görüntü + motorun kendi yolu var → { kind:'engine-keys' } → renderer o
  //     baytı pane'e yazar, motor panoyu kendisi okur (claude → `[Image #N]`).
  //   • pano görüntü + motor bilmiyor (kabuk) → bayt'lar `saveTempImage`'a (sürükle-
  //     bırakın AYNI mekanizması) → { kind:'image', path } → renderer yolu yapıştırır.
  //   • aksi hâlde                            → bugünkü metin yolu, DEĞİŞMEDEN.
  // Görüntü kararı yalnız pano METİNSİZ iken verilir: bir web sayfasından yapılan
  // "kopyala" çoğu zaman metinle BİRLİKTE bir görüntü de bırakır ve orada kullanıcının
  // beklediği metindir — çalışan yolu bozmamak için metin ÖNCELİKLİDİR.
  // GÜVENLİK: pano içeriği yine renderer'a geçmez — geçen şey ya sabit bir kontrol
  // baytı ya da main'in yazdığı temp dosyanın YOLUdur (renderer'ın fs erişimi yok).
  ipcMain.handle('clipboard:pasteFocused', (event, opts) => {
    const paneId = opts && typeof opts === 'object' ? opts.paneId : null;
    try {
      const img = clipboard.readImage();
      // Motoru pane'in KENDİSİNDEN oku (spawn'da kaydedilen durum) — çağıranın
      // iddiasından değil: hangi CLI'ın koştuğunu bilen taraf main'dir.
      const entry = paneId ? ptys.get(paneId) : null;
      const route = clipboardImageRoute.routeClipboardPaste({
        platform: process.platform,
        engine: entry ? entry.command : null,
        hasImage: !!(img && !img.isEmpty()),
        hasText: !!clipboard.readText().trim(),
        filePaths: readClipboardFilePaths(),
      });
      if (route.kind === 'engine-keys') return { ok: true, kind: 'engine-keys', keys: route.keys };
      // WIN-IMG-01 — Windows Explorer kopyası: DOSYA zaten diskte, kopya yazmayız.
      if (route.kind === 'file-path') return { ok: true, kind: 'image', path: route.paths[0], fromDisk: true };
      if (route.kind === 'image') {
        const saved = saveTempImage({ data: img.toPNG(), type: 'image/png', name: 'pasted-image' });
        if (saved.ok) return { ok: true, kind: 'image', path: saved.path, bytes: saved.bytes };
        // WIN-IMG-01 — SESSİZ BAŞARISIZLIK YASAĞI: eskiden yalnız log'a düşüp metin
        // yoluna kayıyordu (kullanıcı için hiçbir şey olmuyordu). Artık sebep ÇAĞIRANA
        // döner ve terminal bunu kullanıcıya GÖSTERİR.
        logLine(`clipboard:pasteFocused image save failed: ${saved.reason || 'unknown'}`);
        return { ok: false, reason: saved.reason || 'image-save-failed' };
      }
    } catch (err) {
      logLine(`clipboard:pasteFocused image probe failed: ${err.message}`);
    }
    try {
      event.sender.paste();
      return { ok: true, kind: 'text' };
    } catch (err) {
      logLine(`clipboard:pasteFocused failed: ${err.message}`);
      return { ok: false, reason: 'paste-failed' };
    }
  });

  // ── ADP-935 — PANO GEÇMİŞİ ────────────────────────────────────────────────
  // Eren: "bir ekrandan 3-5 şey kopyalıyorum, beşinciyi kopyalayınca ilk dördü
  // gitmiş oluyor." Yakalama MAIN'de olmak ZORUNDA: sistem panosunu yalnız main
  // okuyabilir (renderer'da pano OKUMA ucu bilerek yoktur — yukarıdaki duruş).
  //
  // Karar mantığı burada DEĞİL, `clipboardHistory.cjs`te (saf + DI + birim testli):
  // gizlilik kapısı, içerik farkı, döngü kırıcı, tavanlar. Burası yalnız KABLO.
  //
  // 🔒 Geçmiş YALNIZ BELLEKTE — diske yazılmaz, uygulama kapanınca gider.
  const clipHistory = clipboardHistoryCore.createClipboardHistory({
    clipboard,
    onChange: () => broadcastClipChanged(),
    log: (line) => logLine(line),
  });
  // Poll aralığı: ADP-933 ölçümüne göre boş panoda bir tik ~4 µs (availableFormats
  // + readText) ⇒ 700 ms'de CPU payı ~%0.0006. Görüntü okuması çekirdekte ayrıca
  // throttle'lı. `unref` YOK: bu zamanlayıcı uygulama yaşadığı sürece koşmalı
  // (kopyalama başka bir uygulamadayken olur — CrewPane arka planda).
  const clipTimer = setInterval(() => {
    try {
      clipHistory.tick();
    } catch (err) {
      logLine(`[clip] tick hatası: ${err && err.message}`);
    }
  }, 700);
  app.once('before-quit', () => clearInterval(clipTimer));

  // WIN-IMG-01 — görsel deposunun ömür kancaları. TTL kaldırıldığı için temizlik
  // ARTIK BURADA: (1) açılışta ÖNCEKİ çalışmalardan kalan yetim klasörler (çöken
  // oturumlar diskte iz bırakmasın), (2) kapanışta bu çalışmanın kendi klasörü.
  // İkisi de best-effort — temizlik başarısız olursa uygulama akışı ETKİLENMEZ.
  try {
    const swept = imageStore.sweepOrphans();
    if (swept) logLine(`[win-img-01] ${swept} yetim geçici görsel klasörü temizlendi`);
  } catch (err) { logLine(`[win-img-01] yetim süpürme hatası: ${err && err.message}`); }
  app.once('before-quit', () => {
    try { imageStore.dispose(); } catch { /* çıkışı geciktirme */ }
  });

  // ADP-625 — İLK AÇILIŞ DOKTORU (ADP-616 §5.4): "bu kurulum çalışır durumda mı?"
  // Tek çağrı, beş kontrol, üç renk. Eksik dizinleri OLUŞTURUR (idempotent), geri
  // kalanını yalnız RAPORLAR — hiçbir kontrol kapı değildir, uygulama her hâlükârda
  // açılır. Renderer'daki "Sistem Durumu" ekranı da, açılıştaki tek seferlik log da
  // aynı fonksiyonu çağırır (iki yüzey ayrışamaz).
  ipcMain.handle('doctor:run', async () => {
    try {
      return await runDoctorNow();
    } catch (err) {
      logLine(`doctor:run error: ${err && err.message}`);
      return { generatedAt: Date.now(), overall: 'warn', checks: [], error: 'run_failed' };
    }
  });

  // ADP-907 — "dosyayı benim için aç": yabancı kancanın yazılı olduğu AYAR DOSYASINI
  // kullanıcının kendi editöründe açar. İki sınır:
  //   • YAZMA YOK. Uygulama kullanıcının ayar dosyasını ASLA değiştirmez; kararı o verir.
  //   • YOL RENDERER'DAN GELMEZ (ADP-103 capability modeli). Renderer bir yol GÖNDERİR
  //     ama main onu doktorun KENDİ ürettiği aday listesiyle karşılaştırır; listede
  //     değilse açmaz. Yani bu köprüden rastgele bir dosya açtırılamaz.
  ipcMain.handle('doctor:openHookSettings', async (_event, requested) => {
    const target = typeof requested === 'string' ? requested.trim() : '';
    if (!target) return { ok: false, reason: 'bad-request' };
    const allowed = firstRunDoctor.hookSettingsFiles({
      userHome: hookScanHome(),
      workspaceRoot: agentWorkspaceRoot,
    });
    if (!allowed.some((f) => f.path === target)) {
      logLine(`doctor:openHookSettings reddedildi (liste dışı yol)`);
      return { ok: false, reason: 'not-allowed' };
    }
    try {
      if (!fs.existsSync(target)) return { ok: false, reason: 'missing' };
      const err = await shell.openPath(target);
      // openPath boş dize dönerse açıldı; dolu dönerse ilişkili uygulama yok →
      // dosyayı klasörde göster (kullanıcı çıkmaz sokakta kalmasın).
      if (err) { shell.showItemInFolder(target); return { ok: true, via: 'folder' }; }
      return { ok: true, via: 'editor' };
    } catch (e) {
      logLine(`doctor:openHookSettings hata: ${String((e && e.message) || e)}`);
      return { ok: false, reason: 'open-failed' };
    }
  });

  // ── ADP-597 — ABONELİKLE GİRİŞ (Ayarlar → AI Motorları → "Hesap ile giriş") ──
  //
  // Kullanıcı terminale HİÇ dokunmadan `claude` / `codex` oturumunu açar. Akış
  // main'de yönetilir; renderer yalnız anlık-görüntü görür ve iki şey gönderir:
  // "başlat" ve (claude'da) tarayıcının verdiği KOD. Child handle, ham CLI çıktısı
  // ve kod ASLA renderer'a geçmez.
  //
  // Aynı anda TEK oturum: ikinci bir "Giriş yap" isteği öncekini iptal eder —
  // yoksa iki child aynı callback portu/stdin'i için yarışırdı.
  let activeLogin = null;

  const pushAuthEvent = (payload) => {
    // Ayarlar hangi pencerede açıksa oraya — tek yüzey (sendPaneEvent'in muadili).
    if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('engineAuth:changed', payload);
  };

  // ── ADP-936 — HESAP PROFİLİ boğazı (ADR-MULTI-ACCOUNT-SWITCH) ─────────────
  //
  // Motorun durumu HANGİ HESAP için okunuyorsa, ajanlar da onunla koşmalı. İkisi
  // AYNI çözücüden (engineProfiles) beslendiği için "rozet A'yı gösterirken pane
  // B'yi yakıyor" ayrışması yapısal olarak imkânsız. Varsayılan profilde env
  // katkısı BOŞ → bugünkü tek-hesap kullanıcı için davranış bit-bit aynı.
  const profilesHome = () => instancePaths.crewpaneHome();
  const profileEnvFor = (engine, profileId) =>
    engineProfiles.applyProfileEnv(process.env, profilesHome(), engine, profileId);
  const activeProfileOf = (engine) => engineProfiles.activeProfileId(profilesHome(), engine);

  // ── ENG-08 — API ANAHTARI YEDEĞİ (abonelik birinci sınıf, anahtar YEDEK) ───
  // Anahtar ADP-584 vault'unda (entegrasyon anahtarlarıyla AYNI kasa, aynı kapı);
  // buradan yalnız bir DEPO GÖRÜNÜMÜ geçer, sır renderer'a ASLA çıkmaz. Vault
  // tembel kurulur (`integrations()`) — anahtar yolu olmayan kullanıcıda hiç
  // dokunulmaz; hata durumunda `null` → engineAuth dürüstçe 'vault-unavailable' der.
  /** engineAuth çağrılarının ORTAK bağlamı: profil env'i + anahtar deposu. */
  const authDeps = (engine, profileId) => ({
    env: profileEnvFor(engine, profileId),
    apiKeyStore: engineKeyStore(),
    // ENG-HONEST-CARD-01 — satıcı kapısı POLİTİKASI kartta gerçek ayarı göstersin:
    // spawn kapısı (`vendorGateVerdict`) ayarı okuyordu, rozet okumuyordu → kullanıcı
    // "block" yazsa kart hâlâ "allow" derdi. İki yüzey aynı ayardan okur.
    settings: agentSettings.readSettings(),
    log: (m) => logLine(engineAuth.maskSecrets(m)),
    // ENG-F4-01 — motor+profile BAĞLI defter dikişi. `apiKeyStore` ile aynı desen:
    // engineAuth'a yol/`fs` sızmaz, yalnız "var mı / yaz / sil" geçer. Defter
    // HANGİ HESABA girildiğini de ayırır — profil A'da yapılan giriş, profil B'nin
    // rozetini yeşiltemez (`engineProfiles` boğazıyla aynı iki-eksen kuralı).
    loginLedger: engineLoginLedger.bindLedger(profilesHome(), engine, profileId),
  });
  /** Bir profilin oturum durumu — HER ZAMAN motorun kendi komutundan (ADP-597 kuralı). */
  const readProfileStatus = (engine, profileId) =>
    engineAuth.readStatus(engine, authDeps(engine, profileId)).catch(() => null);
  /**
   * ACCT-FIX-01 — durum çıktısından kimlik damgası yazar (giriş bitince / geriye
   * doldurma). Girişsiz/boş durum damga ÜRETMEZ. Log'a yalnız maskeli e-posta girer.
   */
  const stampProfileIdentity = (engine, profileId, status, source) => {
    const identity = engineProfiles.identityFromStatus(status, { source });
    if (!identity) return false;
    const r = engineProfiles.setProfileIdentity(profilesHome(), engine, profileId, identity);
    if (r.ok) {
      logLine(`engine account identity stamped engine=${engine} profile=${profileId} source=${source} account=${engineProfiles.maskAccount(identity.email || '')}`);
    }
    return r.ok;
  };
  /** Bu kurulumda auth yönetilebilen motorlar (defter + e2e dikişi). */
  const authEngineIds = () => engineAuth.authEngines({ env: process.env });
  const pushProfilesEvent = () => {
    if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('engineProfiles:changed', { at: Date.now() });
  };

  // ── Engine, Engine Auth, and Multi-Account Profiles IPC (Faz 3.5 — Sıra 7) ─
  registerEngineIpc({
    ipcMain,
    engineCheck,
    capabilityRegistry,
    paneCapabilityMatrix,
    engineOffering,
    engineDelegation,
    engineLeadership,
    enginePlanned,
    authEngineIds,
    readProfileStatus,
    activeProfileOf,
    authDeps,
    engineAuth,
    logLine,
  });

  registerEngineAuthIpc({
    ipcMain,
    shell,
    engineAuth,
    engineProfiles,
    authEngineIds,
    activeProfileOf,
    authDeps,
    pushAuthEvent,
    pushProfilesEvent,
    stampProfileIdentity,
    profilesHome,
    getActiveLogin: () => activeLogin,
    setActiveLogin: (val) => { activeLogin = val; },
    logLine,
  });

  registerEngineProfilesIpc({
    ipcMain,
    engineProfiles,
    engineAuth,
    engineSwitch,
    limitDetect,
    resumePtyDaemon,
    livePaneRegistry,
    crewpaneHome,
    profilesHome,
    authEngineIds,
    readProfileStatus,
    stampProfileIdentity,
    pushProfilesEvent,
    ptys,
    getAppWindow: () => appWindow,
    spawnPty,
    killPane,
    respawnOptsFromEntry,
    agentEngineMirror,
    logLine,
  });

  // ADP-232 — thin relaunch WITHOUT the rebuild: restart-gated settings (a changed
  // workspaceRoot) need only a process restart, not `electron:build:prep` (which is
  // the dev-builder path above and would be slow/side-effectful here). No renderer
  // input, works packaged too. The short delay lets the renderer paint its
  // "yeniden başlatılıyor…" state before the window dies.
  ipcMain.handle('app:relaunch', () => {
    // ADP-232-C — e2e seam (CREWPANE_DISABLE_AUTORESUME deseni): Playwright-Electron
    // altında gerçek relaunch ÖKSÜZ bir app instance'ı doğurur (yeni kopya harness'a
    // bağlı değil). first-run gate spec'i relaunch ÇAĞRISINI doğrular, exec'ini değil.
    if (process.env.CREWPANE_E2E_BLOCK_RELAUNCH === '1') {
      logLine('relaunch: suppressed (e2e seam)');
      return { ok: true, suppressed: true };
    }
    logLine('relaunch: requested (settings restart-apply)');
    setTimeout(() => relaunchApp('settings-restart'), 400);
    return { ok: true };
  });

  // A-10 — "Yenilikler" (changelog) IPC yüzeyi. Salt-okunur: renderer hiçbir
  // adres/ID göndermez, yalnız durumu okur (announce'un aksine aksiyon linki yok).
  ipcMain.handle('changelog:get', () => changelogStateForRenderer());
  ipcMain.handle('changelog:checkNow', () => runChangelogCheck('manual'));
  ipcMain.handle('changelog:openUrl', (_event, url) => {
    // announce:openLink ile AYNI disiplin: adres renderer'dan gelse de main KENDİ
    // bildiği (zaten https doğrulanmış) kayıt listesindeki bir adresle EŞLEŞMELİ.
    const target = typeof url === 'string' ? url.trim() : '';
    if (!target || !changelogState.items.some((e) => e.url === target)) {
      return { ok: false, reason: 'unknown-url' };
    }
    shell.openExternal(target);
    logLine(`changelog: link açıldı → ${target}`);
    return { ok: true, url: target };
  });

  // Autotest-only proof channels (spike regression harness, not product API).
  ipcMain.on('spike:rendered', (_event, chunk) => {
    try { if (LOG_PATH) fs.appendFileSync(LOG_PATH, '[rendered] ' + JSON.stringify(chunk) + '\n'); } catch { /* best-effort */ }
  });
  ipcMain.on('spike:done', (_event, summary) => {
    logLine('autotest summary: ' + JSON.stringify(summary));
    setTimeout(() => { noteQuit('watchdog', 'autotest-done'); app.quit(); }, 200);
  });
}

// ---------------------------------------------------------------------------
// Embedded Next server (dev/prod) — port management + ready-wait + clean kill.
// ---------------------------------------------------------------------------

let nextServer = null; // child_process of `next dev` / standalone server.js
// SMOKE-ISO-01 — beklenmedik ölüm bütçesi (pencere başına 1 yeniden başlatma).
let nextServerRestartState = nextServerPolicy.initialState();

/** Reserve a free TCP port from the OS, then release it for Next to bind. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Poll the server until it answers an HTTP request (any status) or we time out. */
function waitForServer(url, { timeoutMs = 60000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error(`server not ready within ${timeoutMs}ms: ${url}`));
        else setTimeout(attempt, intervalMs);
      });
      req.setTimeout(2000, () => req.destroy());
    };
    attempt();
  });
}

function standaloneDir() {
  const localStandalone = path.join(__dirname, 'standalone');
  if (fs.existsSync(localStandalone)) return localStandalone;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'standalone')
    : path.join(REPO_ROOT, '.next', 'standalone');
}

// ADP-434 — mobil sprite dizini. Paketli app'te `public/` app.asar İÇİNDE DEĞİL,
// `standalone/public/` altındadır (Next standalone extraResources); REPO_ROOT ise
// app.asar'a düşer → `REPO_ROOT/public/sprites` bulunamaz, gateway 404 basar ve telefon
// baş-harf kutusuna düşer. Var olan ilk adayı seç: paketli → standalone; kaynaktan
// koşarken → REPO_ROOT (next dev burayı servis eder), yoksa dogfood standalone kopyası.
function mobileSpriteDir() {
  const candidates = app.isPackaged
    ? [
        path.join(standaloneDir(), 'public', 'sprites', 'characters'),
        path.join(REPO_ROOT, 'public', 'sprites', 'characters'),
      ]
    : [
        path.join(REPO_ROOT, 'public', 'sprites', 'characters'),
        path.join(standaloneDir(), 'public', 'sprites', 'characters'),
      ];
  return candidates.find((d) => fs.existsSync(d)) || candidates[0];
}

// ADP-556 — mobil WEB arayüzü kökü (expo export çıktısı). Paketli app'te extraResources
// `mobile-web` olarak gelir (electron/package.json build.extraResources); kaynaktan
// koşarken `mobile/dist` (üretimi: npm run mobile:web:export). index.html yoksa null →
// gateway yalnız API sunar (eski davranış), telefon `/`te not-found görür.
function mobileWebRoot() {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'mobile-web'), path.join(REPO_ROOT, 'mobile', 'dist')]
    : [path.join(REPO_ROOT, 'mobile', 'dist'), path.join(process.resourcesPath, 'mobile-web')];
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) || null;
}

/**
 * Start the embedded Next server for the given mode and resolve to its base URL.
 * Both modes run via the bundled Electron node (ELECTRON_RUN_AS_NODE) so a
 * packaged app never depends on a system Node install.
 */
async function startNextServer(mode, opts = {}) {
  // SMOKE-ISO-01 — YENİDEN BAŞLATMADA AYNI PORT ŞART. Port `getFreePort()` ile
  // dinamiktir (iki kopya çakışmaz — ölçüldü), ama pencereler zaten yüklenmiş
  // `http://127.0.0.1:<port>` URL'siyle yaşıyor: yeni bir porta kalkan sunucu
  // uygulamayı kapatmaktan kurtarır ama pencereyi ÖLÜ bir adrese bakar hâlde
  // bırakırdı. Ölen sunucunun portu serbesttir; aynı porta geri kalkarız.
  const port = Number.isFinite(opts.port) ? opts.port : await getFreePort();
  const host = '127.0.0.1';
  const url = `http://${host}:${port}`;
  // ADP-234 — hand the resolved workspace root to the embedded Next server so
  // server-side readers (src/lib/reports.ts reportsDirs) can derive workspace-scoped
  // dirs; they run in a separate process and cannot see agentWorkspaceRoot directly.
  const nodeEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // ADP-232-C — unset root must stay UNSET: env values are stringified, so a null
    // here would reach reports.ts as the literal string "null" and existsSync("null").
    ...(agentWorkspaceRoot ? { CREWPANE_WORKSPACE_ROOT: agentWorkspaceRoot } : {}),
    // REPORTS-ROOT-01 (FB-1007) — okuyucu (src/lib/reports.ts) supervisor'ın kök kuralını
    // çağırır ama ayarı/defteri göremez (ayrı süreç): eşlenmiş repo kökleri buradan gider.
    // `<root>/<proje>` adaylarını okuyucu her çağrıda diskten türetir (sonradan doğan
    // dizin yeniden başlatma istemez). Yalnız Next çocuğuna yazılır; pane env'ine SIZMAZ.
    ...crewpaneEnv.dualWrite({}, 'PROJECT_ROOTS', mappedProjectRootsForReports().join(path.delimiter)),
    // ADP-727 (katman B) — ÇOCUK TARAFI NÖBETÇİ. `before-quit` bir SIGKILL'de
    // (jetsam bellek-baskısı kill'i, Force Quit, çökme) HİÇ koşmaz; macOS çocuğu
    // ebeveynle birlikte öldürmez → Eren'in makinesinde 11 yetim `next-server`
    // birikmişti (en eskisi 8 gün 17 saat, biri %340 CPU). Sunucu artık kendi
    // ebeveynini yoklar ve ebeveyn ölünce KENDİNİ sonlandırır.
    CREWPANE_PARENT_PID: String(process.pid),
    // `--require` ÇOCUK süreçte çözülür → yol app.asar İÇİNİ göstermemeli
    // (ADP-226'nın instancePaths.cjs yarası: asar'dan yüklenemeyen dosya = sessiz
    // ölüm, yalnız PAKETLİ build'de). agentRunner'ın mevcut çözücüsü yeniden
    // kullanılıyor; dosya electron/package.json `asarUnpack` listesine eklendi.
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require ${JSON.stringify(path.join(__dirname, 'src', 'core', 'helperWatchdog.cjs'))}`,
  };

  if (mode === 'dev') {
    const nextBin = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
    logLine(`starting next dev on ${url} (cwd=${REPO_ROOT})`);
    nextServer = spawn(
      process.execPath,
      [nextBin, 'dev', '--hostname', host, '--port', String(port)],
      { cwd: REPO_ROOT, env: nodeEnv, stdio: 'inherit' },
    );
  } else {
    const serverJs = path.join(standaloneDir(), 'server.js');
    if (!fs.existsSync(serverJs)) {
      throw new Error(
        `standalone server not found at ${serverJs}. Run "npm run build" (and copy ` +
        `.next/static + public into .next/standalone) — see npm run electron:build:prep.`,
      );
    }
    logLine(`starting standalone server on ${url} (${serverJs})`);
    nextServer = spawn(process.execPath, [serverJs], {
      cwd: standaloneDir(),
      env: { ...nodeEnv, NODE_ENV: 'production', PORT: String(port), HOSTNAME: host },
      stdio: 'inherit',
    });
  }

  const proc = nextServer;
  // ADP-727 (katman A) — defter: pid + ps başlangıç zamanı + komut imzası diske
  // yazılır. Bir sonraki açılış, çökmeden sağ çıkan yardımcıyı BUNDAN bulup
  // toplar (SIGKILL'de hiçbir JS handler koşmadığı için tek güvenilir yol).
  try {
    helperReaper.recordHelper(crewpaneHome(), {
      pid: proc.pid, kind: 'next-server',
      // İmza AYIRT EDİCİ olmalı: düz 'next' herhangi bir komut satırında geçebilir
      // ve üçlü kapının üçüncü ayağını işlevsiz bırakırdı.
      signature: mode === 'dev' ? 'next/dist/bin/next' : 'server.js',
    });
  } catch { /* best-effort — defter yoksa app yine açılır */ }
  proc.on('exit', (code, signal) => {
    logLine(`next server exited code=${code} signal=${signal ?? '-'}`);
    try { helperReaper.forgetHelper(crewpaneHome(), proc.pid); } catch { /* best-effort */ }
    if (nextServer === proc) nextServer = null;
    // If the server dies UNEXPECTEDLY while the app is up, try to bring it back;
    // only a SECOND death in the same window tears the app down.
    // ADP-334: an INTENTIONAL stopNextServer() must NOT quit the app (it did — that is
    // how closing the window killed the whole app, mobile gateway included).
    if (!app.isQuitting && !proc.__stopping) {
      // SMOKE-ISO-01 — ÖLÇÜLDÜ (kontrol kolu, kaynak koşumu): gömülü sunucuya
      // DIŞARIDAN tek bir SIGTERM gelmesi (`code=143`) bu dal yüzünden TÜM
      // uygulamayı kapatıyordu — 11 pane, açık oturumlar, kaydedilmemiş her şey.
      // "Sunucu öldü" ≠ "sunucu bir daha kalkmıyor": önce AYNI PORTA geri kaldır,
      // yalnız aynı pencerede ikinci ölümde kapat (kural+ölçüm: nextServerPolicy.cjs).
      const decision = nextServerPolicy.decideOnUnexpectedExit(nextServerRestartState, Date.now());
      nextServerRestartState = decision.state;
      if (decision.action === 'restart') {
        logLine(`next server beklenmedik öldü (code=${code} signal=${signal ?? '-'}) → ${decision.why}; port ${port} korunuyor (deneme ${decision.attempt})`);
        startNextServer(mode, { port }).then(
          () => logLine(`next server yeniden ayakta: http://${host}:${port}`),
          (err) => {
            logLine(`next server yeniden başlatılamadı: ${(err && err.message) || err}`);
            noteQuit('next-server-gone', `restart-failed code=${code} signal=${signal ?? '-'}`);
            app.quit();
          },
        );
        return;
      }
      // CRASH-R1 — sebep deftere düşer: bir dahaki sefere "uygulama kendiliğinden
      // kapandı" sorusunun cevabı ilk açılış satırında hazır olur.
      logLine(`next server yine öldü → ${decision.why}; kapatılıyor`);
      noteQuit('next-server-gone', `code=${code} signal=${signal ?? '-'} ${decision.why}`);
      app.quit();
    }
  });
  nextServer.on('error', (err) => logLine(`next server spawn error: ${err.message}`));

  await waitForServer(url);
  logLine(`next server ready: ${url}`);
  return url;
}

function stopNextServer() {
  if (nextServer && !nextServer.killed) {
    logLine('killing next server');
    nextServer.__stopping = true; // ADP-334 — kasıtlı durdurma: 'exit' app'i KAPATMASIN
    // ADP-727 — SIGTERM TEK BAŞINA YETMEZ: açık soketi/isteği olan bir Next
    // sunucusu SIGTERM'i yutup yaşamaya devam edebilir. 3 sn nezaket, sonra SIGKILL.
    // NOT: `before-quit` yolunda main bu 3 sn dolmadan ölebilir ve zamanlayıcı hiç
    // ateşlemez — ORASI zaten katman B'nin (çocuk nöbetçisi) işi. Bu ek, main'in
    // YAŞAMAYA DEVAM ettiği yolları kapatır (window-all-closed non-darwin, rebuild).
    helperReaper.killWithGrace(nextServer.pid, { graceMs: 3000 });
  }
  nextServer = null;
}

// ---------------------------------------------------------------------------
// ADP-139 (DOGFOOD Engel #2) — one-click "Rebuild & Relaunch" (option B).
// ---------------------------------------------------------------------------
// The dev-mode profile (CREWPANE_MODE=dev → `next dev` HMR) gives instant
// renderer hot-reload and is the primary self-host path. This is the FALLBACK for
// when the user is dogfooding the prod standalone build FROM SOURCE: a single click
// rebuilds the standalone bundle (`electron:build:prep`) and relaunches the app so
// a renderer edit is reflected without leaving the app or running a terminal command.
//
// Security: the command + args are FIXED (`npm run electron:build:prep`) — nothing
// is taken from the renderer, so there is no RCE surface (same disiplin as ptyApi's
// command whitelist). Gated to the source tree (never a packaged .app, which has no
// source/npm). Single-flight so two clicks can't race two builds.
let rebuildInFlight = false;
function rebuildAndRelaunch(event) {
  if (app.isPackaged) return { ok: false, reason: 'packaged-unsupported' };
  if (rebuildInFlight) return { ok: false, reason: 'busy' };
  rebuildInFlight = true;

  const sender = event && event.sender;
  const emit = (payload) => {
    try { if (sender && !sender.isDestroyed()) sender.send('app:rebuild:progress', payload); } catch { /* best-effort */ }
  };

  logLine('rebuild: starting `npm run electron:build:prep`');
  emit({ phase: 'start', line: 'Yeniden derleniyor… (electron:build:prep)' });

  // FIXED command/args — no renderer-supplied input. cwd = the source repo root.
  const child = spawn('npm', ['run', 'electron:build:prep'], {
    cwd: REPO_ROOT,
    env: process.env,
  });

  const pipeLines = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) { logLine('rebuild: ' + line); emit({ phase: 'log', line }); }
      }
    });
  };
  pipeLines(child.stdout);
  pipeLines(child.stderr);

  child.on('error', (err) => {
    rebuildInFlight = false;
    logLine(`rebuild: spawn error: ${err.message}`);
    emit({ phase: 'error', line: `Derleme başlatılamadı: ${err.message}` });
  });
  child.on('exit', (code) => {
    rebuildInFlight = false;
    if (code === 0) {
      logLine('rebuild: success → relaunching');
      emit({ phase: 'done', line: 'Derleme tamam — yeniden başlatılıyor…' });
      // Give the renderer a beat to render the "relaunching" state before we go.
      setTimeout(() => relaunchApp('rebuild'), 400);
    } else {
      logLine(`rebuild: failed code=${code}`);
      emit({ phase: 'error', line: `Derleme başarısız (çıkış kodu ${code}). Terminalden \`npm run electron:build:prep\` ile detayları gör.` });
    }
  });

  return { ok: true, started: true };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// ADP-888 (ADP-885 Faz A) — ARAYÜZ DİLİNİN TEK KARAR NOKTASI.
//
// Tercih settings.json'da ('system'|'tr'|'en'), ETKİN dil burada çözülür ve üç
// tüketiciye BURADAN dağılır: (1) main'in kendi diyalogları, (2) yeni pencerelerin
// additionalArguments bayrağı, (3) açık pencerelere canlı push. İkinci bir yerde
// çözülseydi "ayarda İngilizce, diyalogda Türkçe" kaçınılmazdı (iki gerçek).
function applyAppLocale() {
  let preference = appI18n.DEFAULT_LOCALE_PREFERENCE;
  try {
    preference = agentSettings.readSettings().locale;
  } catch { /* ayar okunamazsa 'system' — dil yüzünden açılış düşmez */ }
  let systemLocale = '';
  try {
    systemLocale = app.getLocale();
  } catch { /* whenReady öncesi/headless — İngilizceye düşer */ }
  // ADP-889 — SİSTEM ETİKETİ PİNİ (yalnız otomasyon). TERCİH'i EZMEZ: kullanıcı
  // 'tr'/'en' seçtiyse o kazanır, bu değer yalnız tercih 'system' iken okunan
  // işletim sistemi etiketinin yerine geçer ("OS bu dilde davransın").
  // NEDEN: e2e korpusu (21 spec) Türkçe arayüze göre yazıldı; bu makinede
  // app.getLocale() 'en-US' döner (ÖLÇÜLDÜ) → sihirbaz çevrilince o spec'ler
  // makinenin diline göre kırmızıya döner. Testin dili ORTAMA bırakılamaz.
  const pinnedSystemLocale = process.env.CREWPANE_SYSTEM_LOCALE;
  if (typeof pinnedSystemLocale === 'string' && pinnedSystemLocale.trim()) {
    systemLocale = pinnedSystemLocale.trim();
  }
  const locale = appI18n.setLocale(preference, systemLocale);
  return { locale, preference: appI18n.getPreference() };
}

/** Yeni pencerelerin argv bayrağı + açık pencerelere canlı push (route değişmez). */
function broadcastLocale() {
  const state = applyAppLocale();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send('app:locale-changed', state);
    } catch { /* best-effort */ }
  }
  logLine(`locale: tercih=${state.preference} etkin=${state.locale}`);
  return state;
}

// ── Pencere Yönetimi (Faz 3.3): BrowserWindow yönetimi src/main/windows altında ──
windowManager = createWindowManager({
  BrowserWindow,
  shell,
  screen,
  Notification,
  app,
  preloadPath: path.join(__dirname, 'dist', 'preload.js'),
  supabaseTarget,
  rendererSupabaseTarget,
  appI18n,
  applyAppLocale,
  isTest: instancePaths.isTest(),
  crewpaneHome,
  APP_PROBE,
  PROBE_WAIT,
  PROBE_CLICKS,
  PROBE_PATH,
  START_PATH,
  AUTOTEST,
  getAppWindow: () => appWindow,
  setAppWindow: (w) => { appWindow = w; },
  getAppBaseUrl: () => appBaseUrl,
  setAppBaseUrl: (u) => { appBaseUrl = u; },
  setPanesRestored: (val) => { panesRestored = val; },
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  logLine,
  rebindOrphanPanes,
  restoreLivePanes,
  startPtyResumeDaemonOnce,
  ptys,
  noteQuit,
  crashWatchdog,
  keepPanesAliveOnWindowClose,
  liveAgentPaneCount,
  killPtysForWindow,
  quitFunnel,
  armQuitBrake,
  reportsWatcher,
  activeWorktreePaths,
  mappedProjectRootsForReports,
  browserGuests,
  ghostGuests: () => ghostGuests,
  guestOwners,
  agentGuests,
  getPendingAgentTabs: () => pendingAgentTabs,
  getAppWindowGuest: () => appWindowGuest,
  setAppWindowGuest: (g) => { appWindowGuest = g; },
  lastUnownedGuest,
  getHandControl: () => handControl,
  stopHandControl,
  broadcastHandControlStatus,
});

function sharedWebPreferences() { return windowManager.sharedWebPreferences(); }
function attachHtmlFullscreenGuard(win, wc) { return windowManager.attachHtmlFullscreenGuard(win, wc); }
function applyGuestPermissionPolicy(ses) { return windowManager.applyGuestPermissionPolicy(ses); }
function attachWebviewGuards(win) { return windowManager.attachWebviewGuards(win); }

// ADP-095 — write a CDP base64 PNG screenshot to a temp file; return its path.
// WIN-IMG-01 — TTL YOK: aynı oturum deposundan geçer (ajanın kanıt-screenshot'ları
// da geç okunabilir; "5 dk yeter" varsayımı burada da geçersizdi).
function saveBrowserShot(base64, tag) {
  const res = imageStore.save({
    data: Buffer.from(String(base64 || ''), 'base64'),
    type: 'image/png',
    name: tag || 'shot',
    prefix: 'crewpane-browser',
  });
  if (res.ok) return res.path;
  logLine(`browser screenshot save failed: ${res.reason || 'unknown'}`);
  return null;
}

// ADP-095 — main-side CDP action runner the delegation bridge calls after approval.
// Drives the live <webview> guest (visible to the user) via its debugger. Emits a
// `browser:activity` event to the renderer for the activity log (visual feedback).
/**
 * ADP-333 — bir ajan için KENDİ sekmesini çöz. Yoksa (ya da kullanıcı kapattıysa)
 * renderer'dan ARKA PLANDA yeni bir sekme ister ve sahiplenir. Kullanıcının sekmesine
 * ASLA düşmez: burada "aktif sekme" hiç okunmaz.
 */
async function resolveAgentGuest(agentId) {
  const owned = agentGuests.get(agentId);
  logLine(`[adp333] resolve agent=${agentId} owned=${owned ? owned.id : 'YOK'} guests=[${[...browserGuests.keys()].join(',')}] owners=${JSON.stringify([...guestOwners.entries()])}`);
  if (owned && !owned.isDestroyed()) return owned;
  agentGuests.delete(agentId);
  if (!appWindow || appWindow.isDestroyed()) {
    throw new Error('uygulama penceresi kapalı — ajan sekmesi açılamıyor');
  }
  // Renderer arka planda (kullanıcının odağını ÇALMADAN) bir sekme açar, guest id'si
  // hazır olunca 'browser:setTabOwner' ile sahipliği bildirir.
  // ADP-396 — sekme AÇILANA KADAR "bir ajan sekmesi bekleniyor" bayrağı: bu aralıkta
  // gelen attach insan hedefini (appWindowGuest) DEĞİŞTİRMEZ.
  pendingAgentTabs++;
  try {
    appWindow.webContents.send('browser:agent-tab', { agentId, url: 'about:blank' });
    const deadline = Date.now() + 10000;
    for (;;) {
      const g = agentGuests.get(agentId);
      if (g && !g.isDestroyed()) return g;
      if (Date.now() > deadline) {
        throw new Error(`ajan sekmesi açılamadı (${agentId}) — kullanıcının sekmesi KULLANILMAZ, işlem yapılmadı`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } finally {
    if (pendingAgentTabs > 0) pendingAgentTabs--;
  }
}

/**
 * ADP-341 — güven kapısının TEK örneği: oturum izinleri ve DURDUR sayacı main ile
 * bridge arasında PAYLAŞILIR (iki ayrı defter = iptal edilmeyen izin demektir).
 */
function browserGate() {
  return browserGateMod.getBrowserGate({ log: logLine });
}

/**
 * Bir eylemin koşacağı guest: ajan → KENDİ sekmesi, insan (Jarvis/renderer, agentId YOK)
 * → aktif sekme. Risk probu ile eylemin AYNI sekmeyi görmesi şart — yoksa "başka sekmede
 * ölçüp burada tıklamak" gibi bir güvenlik deliği açılırdı (ADP-341).
 */
async function resolveGuestFor(value) {
  const agentId = value && typeof value.agentId === 'string' ? value.agentId.trim() : '';
  if (agentId) return resolveAgentGuest(agentId);
  // ── İNSAN yolu (Jarvis / renderer) ────────────────────────────────────────────
  // ADP-396 ÜÇÜNCÜ SAVUNMA: hedefe rağmen sahipli bir guest sızdıysa (renderer yanlış
  // bildirdi / gelecekteki bir regresyon), ajanın sayfasında ASLA koşma — sahipsiz
  // sekmeye dön. Hiç sahipsiz sekme yoksa dürüstçe patla (sessizce ajanın sekmesinde
  // tıklamak, düzeltmeye çalıştığımız bug'ın ta kendisidir).
  let guest = appWindowGuest;
  if (guest && !guest.isDestroyed() && isOwnedGuest(guest.id)) {
    logLine(`[adp396] insan hedefi SAHİPLİ guest'e işaret ediyordu (${guestOwners.get(guest.id)}) → sahipsiz sekmeye dönülüyor`);
    guest = lastUnownedGuest();
    appWindowGuest = guest;
  }
  if (!guest || guest.isDestroyed()) {
    throw new Error('internal browser not open (no guest webContents attached). Open the Browser tab in the app.');
  }
  return guest;
}

/**
 * ADP-341 (ADR-026 §2) — RİSK PROBU: kapı karar vermeden ÖNCE gerçek bağlamı ölç.
 *   • origin: eylemin koşacağı guest'in KENDİ adresi (ajanın payload'ı değil → uyduramaz)
 *   • hedef eleman: CDP `Runtime.evaluate` ile eylemden ÖNCE (parola alanı mı? "Öde" butonu mu?)
 * Prob patlarsa throw eder; kapı bunu "hedef bilinmiyor → SOR" olarak okur.
 */
async function probeBrowserTarget(value) {
  const guest = await resolveGuestFor(value);
  const url = typeof guest.getURL === 'function' ? guest.getURL() : '';
  const selector = value && typeof value.selector === 'string' ? value.selector : '';
  if (!selector) return { url, elementInfo: null };
  const info = await browserCdp.readElementInfo(guest.debugger, selector);
  return { url, elementInfo: info.elementInfo, found: info.found };
}

// ── ADP-394 — HAYALET MOD: ajanın sekmesi GÖRÜNMEZ ama KOMPOZE EDİLİR ────────────
//
// ADP-392 (ölçüldü): `display:none` bir <webview>'in guest'i kare üretmez ve viewport'u
// 0×0 olur → CDP fare olayı fiziksel olarak inemez, ekran görüntüsü hiç dönmez. Ajanın
// sekmesi İKİ katmanda gizleniyordu: (1) aktif olmayan sekme (InternalBrowser),
// (2) tarayıcı dock host'u öndeki sekme değilse (WorkspaceDock).
//
// Çözüm: otomasyon KOŞARKEN renderer o guest'i "hayalet"e çevirir (opacity:0.01 +
// pointer-events:none → kompoze edilir, görünmez, tıklanamaz). ADP-333 korunur: ajan
// Eren'in aktif sekmesini/odağını ÇALMAZ, dock'u öne getirmez.
//
// PİL/GPU: hayalet guest sürekli çizilir. Bu yüzden hayalet mod KALICI DEĞİL — yalnız
// eylem sırasında açılır, boşta kapanır (guest yeniden display:none olur, sıfır maliyet).
const GHOST_IDLE_MS = 8000;
const ghostGuests = new Set(); // kompoze edilmesi istenen guest id'leri
let ghostTimer = null;

function sendGhost(guestId, on) {
  try {
    if (appWindow && !appWindow.isDestroyed()) {
      appWindow.webContents.send('browser:composite', { guestId, on });
    }
  } catch { /* best-effort */ }
}

function scheduleGhostRelease() {
  if (ghostTimer) clearTimeout(ghostTimer);
  ghostTimer = setTimeout(() => {
    ghostTimer = null;
    if (ghostGuests.size === 0) return;
    for (const id of ghostGuests) sendGhost(id, false);
    logLine(`[adp394] hayalet mod kapandı (${ghostGuests.size} guest boşta) — GPU/pil tasarrufu`);
    ghostGuests.clear();
  }, GHOST_IDLE_MS);
  ghostTimer.unref?.();
}

// Kompozisyon GEREKTİREN eylemler: fare/kare olmadan sürülemezler. (navigate/read/readPage
// kompoze edilmeyen guest'te de çalışır — onları bekletmeyiz, yalnız hayaleti ısıtırız.)
const NEEDS_COMPOSITE = new Set(['click', 'type', 'screenshot']);

/**
 * ⚠ `innerWidth` KOMPOZİSYON KANITI DEĞİLDİR: gizlenen bir guest, ESKİ düzeninin ölçüsünü
 * korur (0×0 olmaz) — yani "viewport dolu" iken bile kare üretmiyor olabilir. (Bu, ADP-394'ün
 * ilk denemesini yedi: main hayalet modu hiç açmadı, sonraki navigate taze belgeyi gizli
 * host'ta 0×0 açtı ve tıklama yine inmedi.)
 *
 * TEK GÜVENİLİR SİNYAL (ADP-392 ölçümü): kare üretmeyen guest'te `Page.captureScreenshot`
 * HİÇ dönmez. O yüzden hazırlık probu = küçük bir kareyi zaman sınırıyla çekebilmek.
 */
async function producesFrame(guest, ms = 900) {
  let timer;
  const capped = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
  const shot = guest.debugger
    .sendCommand('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 1,
      clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 },
    })
    .then(() => true)
    .catch(() => false);
  try {
    return await Promise.race([shot, capped]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Eylemden ÖNCE guest'in ÇİZİLDİĞİNDEN emin ol. Hayalet modu KOŞULSUZ ister (gizli bir
 * yüzeyde no-op'tur: görünür sekme/dock zaten normal çizilir), sonra guest'in gerçekten
 * kare ürettiğini bekler. Üretmiyorsa dürüstçe patlar — sessizce boşluğa tıklamaz.
 */
async function ensureGuestComposited(guest, action) {
  ghostGuests.add(guest.id);
  sendGhost(guest.id, true);
  if (!NEEDS_COMPOSITE.has(action)) return null; // navigate/read: bekletme, yalnız ısıt
  const deadline = Date.now() + 4000;
  for (;;) {
    if (guest.isDestroyed()) throw new Error('sekme kapandı — otomasyon sürülemez');
    // ⚠ SIRA ÖNEMLİ: readViewport debugger'ı ATTACH eder. Kare probunu önce koşarsak
    // attach'sız debugger'a komut gider, hep patlar ve oturumun İLK eylemi (browser-cdp
    // spec'i tam da bunu yapıyor) sahte "kompoze edilemedi" hatası alır.
    const vp = await browserCdp.readViewport(guest.debugger).catch(() => ({ w: 0, h: 0 }));
    if (vp.w * vp.h > 0 && (await producesFrame(guest))) {
      logLine(`[adp394] guest ${guest.id} kompoze edildi (${vp.w}×${vp.h}) — hayalet mod`);
      return vp;
    }
    if (Date.now() > deadline) {
      throw new Error(
        'sekme kompoze edilemedi (guest kare üretmiyor) — tıklama inmez, işlem YAPILMADI (tarayıcı paneli kapalı/gizli olabilir)',
      );
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function runBrowserAction(value) {
  let guest;
  try {
    guest = await resolveGuestFor(value);
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
  try {
    if (appWindow && !appWindow.isDestroyed()) {
      // ADP-399 (görünürlük) — patron ajanın tarayıcıda NE yaptığını görsün: eylem + hedef +
      // SİTE (origin) + ajan. `owned`=ajan sekmesi mi (renderer buna göre dock'u öne alır,
      // AKTİF SEKMEYİ DEĞİŞTİRMEDEN — Eren kararı: odak çalmadan görünürlük). Origin ajanın
      // payload'ından DEĞİL guest'in kendi URL'inden (uyduramaz — ADP-341 deseni).
      let origin = null;
      try {
        const u = typeof guest.getURL === 'function' ? guest.getURL() : '';
        origin = u ? new URL(u).host || u : null;
      } catch { origin = null; }
      appWindow.webContents.send('browser:activity', {
        action: value.action,
        selector: value.selector || null,
        agentId: value.agentId || null,
        origin,
        owned: !!(value && value.agentId),
        at: Date.now(),
      });
    }
  } catch { /* activity feedback is best-effort */ }
  // ADP-135 — 'back' isn't a CDP action; drive the guest's own nav history (used by
  // Jarvis voice "geri git"). Additive: the agent CDP actions below are untouched.
  if (value && value.action === 'back') {
    try {
      const nav = guest.navigationHistory;
      if (nav && typeof nav.canGoBack === 'function' && nav.canGoBack()) nav.goBack();
      else if (typeof guest.canGoBack === 'function' && guest.canGoBack()) guest.goBack();
      else return { ok: false, error: 'no back history' };
      logLine('browser back');
      return { ok: true, result: { ok: true, action: 'back' } };
    } catch (err) {
      logLine(`browser action error (back): ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  }
  // ADP-884 — 'back'in İKİZLERİ: ileri + yenile. Bunlar da CDP eylemi DEĞİL, guest'in
  // kendi gezinme yüzeyidir (aynı gerekçe, aynı kalıp — ikinci bir mekanizma yok).
  if (value && value.action === 'forward') {
    try {
      const nav = guest.navigationHistory;
      if (nav && typeof nav.canGoForward === 'function' && nav.canGoForward()) nav.goForward();
      else if (typeof guest.canGoForward === 'function' && guest.canGoForward()) guest.goForward();
      else return { ok: false, error: 'no forward history' };
      logLine('browser forward');
      return { ok: true, result: { ok: true, action: 'forward' } };
    } catch (err) {
      logLine(`browser action error (forward): ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  }
  if (value && value.action === 'reload') {
    try {
      if (typeof guest.reload !== 'function') return { ok: false, error: 'reload unsupported' };
      guest.reload();
      logLine('browser reload');
      return { ok: true, result: { ok: true, action: 'reload' } };
    } catch (err) {
      logLine(`browser action error (reload): ${err.message}`);
      return { ok: false, error: String(err.message || err) };
    }
  }
  try {
    // ADP-394 — eylemden ÖNCE guest'i çizdir (gerekiyorsa hayalet mod). Kompoze edilmeyen
    // bir sekmede tıklama inmez; bunu SESSİZCE denemek yerine burada kesinleştiriyoruz.
    await ensureGuestComposited(guest, value.action);
    const result = await browserCdp.runCdpAction(guest.debugger, value, {
      saveScreenshot: saveBrowserShot,
      log: logLine,
      // ADP-095 — navigate via the webContents (headed, visible), not CDP
      // Page.navigate (which can close the debugger target). Resolves once the
      // load settles (or a hard cap) so the next CDP read sees the new document.
      navigate: (url) =>
        new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            guest.removeListener('did-stop-loading', finish);
            guest.removeListener('did-finish-load', finish);
            guest.removeListener('did-fail-load', finish);
            resolve();
          };
          guest.on('did-stop-loading', finish);
          guest.on('did-finish-load', finish);
          guest.on('did-fail-load', finish);
          try {
            void guest.loadURL(url);
          } catch {
            finish();
          }
          setTimeout(finish, 8000).unref?.();
        }),
    });
    return { ok: true, result };
  } catch (err) {
    logLine(`browser action error (${value.action}): ${err.message}`);
    return { ok: false, error: String(err.message || err) };
  } finally {
    // Eylem bitti: hayalet mod boşta kapansın (sürekli kompozisyon = pil/GPU).
    scheduleGhostRelease();
  }
}

/**
 * E2E-MUTE-01 — TEST PENCERESİNİ ETİKETLE. Kapı koşusu GERÇEK app'i açar; ekranda
 * beliren pencere ürünün kendisinden ayırt edilemiyordu (Eren "AgentX konuşuyor"
 * derken hangi kopya olduğunu göremiyordu). Yalnız `CREWPANE_INSTANCE=test`
 * kopyasında başlığa bir işaret düşer; müşteri/dev kopyası DEĞİŞMEZ.
 * Offscreen YAPILMADI bilerek: adp816/adp817 pencerenin GERÇEKTEN görünür olmasını
 * ölçer — ekrandan kaçırmak o kapıları körleştirirdi.
 * i18n-exempt: pencere başlığı işareti (arayüz metni değil, ayırt edici damga).
 */
const E2E_WINDOW_TAG = windowManager.E2E_WINDOW_TAG;
function tagTestWindow(win, base) { return windowManager.tagTestWindow(win, base); }
function createAppWindow(url) { return windowManager.createAppWindow(url); }

// ---------------------------------------------------------------------------
// ADP-593 — pane POP-OUT (terminal pane'i ayrı bir macOS penceresine çıkar)
// ---------------------------------------------------------------------------
// EN KRİTİK KISIT: OTURUM ÖLMEZ. pty MAIN'de yaşar (`ptys`) ve sahibi ANA
// penceredir (entry.win). Pop-out yalnız GÖRÜNTÜYÜ taşır: yeni pencere aynı
// paneId'ye `pty:attach` ile bağlanır (ADP-028 replay buffer + seq dedupe) ve
// `pty:data` bu pencereye de yayınlanır. Pop-out penceresi HİÇBİR pty'nin sahibi
// değildir → kapanışında `killPtysForWindow` eşleşmesi olamaz, pty'ye dokunulmaz;
// koşan ajan kesintisiz çalışmaya devam eder. (Popout renderer'ı `attachOnly`
// kipinde çalışır: pane gitmişse taze spawn ETMEZ — sahipsiz pty imkânsız.)
//
// Pencere kapanınca (⌘W / kırmızı düğme / "Geri koy") ana pencereye
// `popout:closed` gider ve pane TAM ESKİ HÜCRESİNE geri döner (hücre hiç
// silinmedi: dışarıdayken yerinde "dışarıda" göstergesi duruyordu).
const popoutWindows = windowManager.popoutWindows;
function popoutWindowFor(paneId) { return windowManager.popoutWindowFor(paneId); }
function sendPaneEvent(win, paneId, channel, payload) { return windowManager.sendPaneEvent(win, paneId, channel, payload); }
function notifyPopoutState(channel, payload) { return windowManager.notifyPopoutState(channel, payload); }
function popoutPaneIdForWindow(win) { return windowManager.popoutPaneIdForWindow(win); }
function broadcastPaneView(paneId, readable) { return windowManager.broadcastPaneView(paneId, readable); }
function broadcastPaneDraft(paneId, text) { return windowManager.broadcastPaneDraft(paneId, text); }
/**
 * AXP-02 — Agent X iş taslağı değişti: ana pencere, widget pop-out'u ve pane
 * pop-out'ları AYNI fotoğrafı görür (taslak main'de tek gerçek; hiçbir yüzey
 * kendi kopyasını tutmaz). Yayın yalnız `changed:true` dönüşlerde (paneDraft deseni).
 */
function agentxDraftTargets() {
  const out = [];
  if (appWindow && !appWindow.isDestroyed()) out.push(appWindow);
  const jw = jarvisWidgetAlive();
  if (jw) out.push(jw);
  for (const w of popoutWindows.values()) if (w && !w.isDestroyed()) out.push(w);
  return out;
}
function broadcastAgentxDraft(snapshot) {
  for (const w of agentxDraftTargets()) w.webContents.send('agentxDraft:changed', snapshot);
}
/** AXP-02 → AXP-03 sözleşmesi: { id, revision, digest, target, text, unitCount, at }. Teslim ilkeli bunu tüketir. */
function broadcastAgentxDraftConfirmed(confirmed) {
  for (const w of agentxDraftTargets()) w.webContents.send('agentxDraft:confirmed', confirmed);
}
/**
 * ADP-935 — pano geçmişi değişti: rozetin sayısı ve açık panel HER yüzeyde
 * tazelensin (ana pencere + pop-out'lar). İçerik TAŞINMAZ, yalnız "değişti"
 * sinyali gider; liste `clip:list` ile ayrıca çekilir (ADP-712 deseni).
 */
function broadcastClipChanged() { return windowManager.broadcastClipChanged(); }
function openPopoutWindow(options) { return windowManager.openPopoutWindow(options); }
function closePopoutWindow(paneId) { return windowManager.closePopoutWindow(paneId); }
function listPopoutPanes() { return windowManager.listPopoutPanes(); }

// ---------------------------------------------------------------------------
// AUID-KABLO (SPRINT-AUID-01) — TASARIM TURUNUN AYRI PENCERESİ (`/design`)
// ---------------------------------------------------------------------------
// AUID-M2 §4'te ÖLÇÜLEN engel: `/design` yüzeyi hazırdı ama uygulama İÇİNDEN
// açılamıyordu — `setWindowOpenHandler` her `window.open`'ı DENY ediyor (renderer
// kendi başına pencere doğuramaz, bilinçli bir güvenlik kararı) ve var olan tek
// pencere-açma yolu `popout:open` CANLI BİR pty'ye bağlı (`ptys.get(paneId)`
// yoksa reddeder) + rotası `/popout`a sabit. Tasarım penceresinin pty'si YOKTUR.
//
// Bu yüzden kendi küçük kapısı: pop-out ve ses widget'ıyla AYNI kalıp
// (BrowserWindow + sharedWebPreferences + dış link → OS tarayıcısı + konum
// defteri), ama pane/pty zincirine HİÇ dokunmadan.
//
// TEKİLLİK sözleşmesi: ikinci çağrı YENİ pencere doğurmaz — var olanı öne getirir
// (`reused:true` döner). Tasarım turu tek bir tuvaldir; iki kopyası aynı
// `docs/design/<görev>/` klasörüne yazsaydı sürüm numaraları yarışırdı.
//
// M1 REGRESYONSUZ: iç tarayıcı pane'inin tasarım modu (D2=a) olduğu gibi durur;
// bu kapı yalnız EK bir yol açar (D2=c). Konum defteri yeniden icat edilmedi —
// ADP-593'ün popoutBounds deposu kendi anahtarıyla (`label:design-window`).
const DESIGN_WINDOW_KEY = windowManager.DESIGN_WINDOW_KEY;
const DESIGN_WINDOW_MIN = windowManager.DESIGN_WINDOW_MIN;

function designWindowAlive() { return windowManager.designWindowAlive(); }
function designPlanDenial({ notify = true } = {}) {
  return planDenial('designMode', 0, { notify });
}
function openDesignWindow() { return windowManager.openDesignWindow(); }
function closeDesignWindow() { return windowManager.closeDesignWindow(); }
function notifyDesignWindowOpen() { return windowManager.notifyDesignWindowOpen(); }

// ---------------------------------------------------------------------------
// ADP-816 (SPRINT-AGENTX-VOICE · Faz 4) — TAŞINABİLİR SES WIDGET'I
// ---------------------------------------------------------------------------
// ADP-804 §8.2'nin kararı: ses widget'ı ana pencerenin İÇİNDE yaşadığı sürece
// "her zaman üstte" imkânsızdır; Eren başka uygulamalarda çalışırken de
// konuşacak. Çözüm, pop-out kalıbının (yukarısı) küçük bir uyarlaması:
//
//   • AYRI BrowserWindow (frameless + transparan + always-on-top + panel tipi)
//   • ODAK ÇALMAZ: `focusable:false` + `type:'panel'` (macOS'ta nonactivating
//     NSPanel) + `showInactive()`. Ana pencere hiçbir zaman öne getirilmez.
//     ADP-265'te ölçülen "onay kartı odak çalar" sınıfı burada tekrarlanamaz.
//   • TAM EKRAN ÜSTÜNDE KALIR: setVisibleOnAllWorkspaces(visibleOnFullScreen)
//     + always-on-top seviyesi — başka bir uygulama tam ekrandayken widget
//     onun Space'inde de görünür.
//   • Klavye YOK (focusable:false → tuş gitmez): widget bir BAKIŞ penceresidir,
//     komut yüzeyi değil. Sürükleme JS ile yapılır (`jarvisWidget:move`), böylece
//     hem gerçek kullanıcı faresiyle hem de e2e ile ÖLÇÜLEBİLİR.
//   • Ana pencere kapansa da YAŞAR: kendi penceresi, kendi süreç-dışı durumu.
//     Durum fotoğrafı MAIN'de tutulduğu için yayıncı ölse bile son bilinen
//     hâli ekranda kalır ve `live:false` ile DÜRÜSTÇE işaretlenir.
//
// Konum defteri yeniden icat EDİLMEDİ: ADP-593'ün popoutBounds deposu, kendi
// anahtarıyla (`label:jarvis-widget`) kullanılır.
const JARVIS_WIDGET_KEY = windowManager.JARVIS_WIDGET_KEY;

function jarvisWidgetAlive() { return windowManager.jarvisWidgetAlive(); }
function jarvisWidgetPayload() { return windowManager.jarvisWidgetPayload(); }
function broadcastJarvisWidget() { return windowManager.broadcastJarvisWidget(); }
function notifyJarvisWidgetOpen() { return windowManager.notifyJarvisWidgetOpen(); }
function jarvisWidgetWorkArea(bounds) { return windowManager.jarvisWidgetWorkArea(bounds); }
function openJarvisWidgetWindow() { return windowManager.openJarvisWidgetWindow(); }
function closeJarvisWidgetWindow() { return windowManager.closeJarvisWidgetWindow(); }
function moveJarvisWidget(payload) { return windowManager.moveJarvisWidget(payload); }

/**
 * Widget'tan "uygulamayı göster": ana pencere kapalıyken TEK geri dönüş yolu.
 * Odak çalmama sözleşmesinin BİLİNÇLİ istisnası — kullanıcının kendi tıklaması.
 */
function showAppFromJarvisWidget() {
  if (appWindow && !appWindow.isDestroyed()) {
    if (appWindow.isMinimized()) appWindow.restore();
    appWindow.show();
    appWindow.focus();
    return { ok: true, created: false };
  }
  if (!appBaseUrl) return { ok: false, error: 'uygulama adresi yok' };
  createAppWindow(appBaseUrl);
  return { ok: true, created: true };
}

// ---------------------------------------------------------------------------
// HAND-A1 — "EL KONTROLÜ" EKRAN ÜSTÜ GÖRSELLEŞTİRME KATMANI
// ---------------------------------------------------------------------------
// Tüm pencerelerin üstünde, TIKLAMA-GEÇİRGEN, tam-ekran çizim katmanı: imleç
// izi · tık · sürükleme · scroll · jest durumu (kamera görüntüsü ASLA burada
// çizilmez — yalnız telemetri sayıları taşınır, OTOPILOT §5).
//
// Pencere kalıbı = ADP-816 (yukarısı) + üç ek: (1) tıklama-geçirgenlik
// `setIgnoreMouseEvents(true,{forward:true})`; (2) tam-ekran bounds — ekran
// başına BİR pencere (HAND-R1 §5.2 kararı; display-added/removed'da yeniden
// kurulur); (3) hasShadow:false (transparan tam-ekran pencerenin gölgesi
// altta kalan her şeyi flulaştırır).
//
// KARE KAYNAĞI bu katman DEĞİL: D mimarisinin tespit döngüsü (gizli
// BrowserWindow — HAND-A2/D kartları) olayları `handOverlay:feed` ile buraya
// iter; katman kaynaktan bağımsızdır (dev besleyici de aynı uçtan konuşur).
// Akış koparsa bekçi katmanı KENDİ KENDİNE kapatır (feedVerdict) — imleci biz
// tutmadığımız için OS imleci zaten normaldir; kaynak geri gelince katman
// yeniden doğar.
const handOverlayWindows = windowManager.handOverlayWindows;
function handTuningConfig(prefs) { return windowManager.handTuningConfig(prefs); }
function handOverlayPrefs() { return windowManager.handOverlayPrefs(); }
function handOverlayAnyAlive() { return windowManager.handOverlayAnyAlive(); }
function openHandOverlayWindows() { return windowManager.openHandOverlayWindows(); }
function closeHandOverlayWindows(reason) { return windowManager.closeHandOverlayWindows(reason); }
function rebuildHandOverlayWindows() { return windowManager.rebuildHandOverlayWindows(); }
function hookHandOverlayScreenEvents() { return windowManager.hookHandOverlayScreenEvents(); }
function startHandOverlayWatchdog() { return windowManager.startHandOverlayWatchdog(); }
function stopHandOverlayWatchdog() { return windowManager.stopHandOverlayWatchdog(); }
function feedHandOverlay(rawEvents) { return windowManager.feedHandOverlay(rawEvents); }
function applyHandOverlaySettings() { return windowManager.applyHandOverlaySettings(); }

// ---------------------------------------------------------------------------
// HAND-A2 — "EL KONTROLÜ" D MİMARİSİ: yaşam döngüsü + izin akışı + acil durdurma
// ---------------------------------------------------------------------------
// Ayrı süreç YOK (Python zinciri emekli — Eren 31.08): el tespiti GİZLİ
// BrowserWindow'da MediaPipe-WASM (yerel paket, /hand/* — CDN yok), landmark
// SAYILARI IPC ile buraya gelir; ekrana eşleme + 1€/balistik + tıklama FSM'i
// main'de (handControlCore, jarvis paritesi fikstürle kilitli), OS imleci
// koffi/CGEvent ile (handCursor). Kamera KARESİ hiçbir zaman main'e/diske/ağa
// gitmez — sayfada bile <video> görünmez (R1 §5.4).
//
// Isınma: pencere açılışta kamerasız yüklenir; sayfa boş kanvasla GPU shader'ı
// derler (ölçülen ilk-çıkarım 0.2–6.2 sn — R3 riski #1). "Açık" rozeti ısınma
// bitmeden yeşile dönmez; kamera ışığı ısınmada YANMAZ (getUserMedia yok).
const { systemPreferences } = require('electron');
const { HandControlEngine } = require('./src/hand/handControlCore.cjs');
const { HandCursor } = require('./src/hand/handCursor.cjs');
const { ZoomRouter, normalizeZoomSurface } = require('./src/hand/handZoomRouter.cjs'); // HAND-G2
const handPoseSampler = require('./src/hand/handPoseSampler.cjs'); // HAND-G4 — poz örnekleyici + kanyon
const handCameraPolicy = require('./src/hand/handCameraPolicy.cjs');
const handDisplayRouter = require('./src/hand/handDisplayRouter.cjs'); // HAND-BUG-03 — hedef ekran yönlendirmesi

const HAND_SHORTCUT = 'CommandOrControl+Shift+H'; // acil durdurma (R1 §5.3-1)
const HAND_STALL_MS = 2000; // motor bu kadar susarsa "stalled" (R1 §5.3-3)
const HAND_STALL_STOP_MS = 6000; // stalled bu kadar sürerse kamerayı kapat

const handControl = {
  phase: 'off', // off | warming | warm | starting | on | stalled
  win: null, // gizli tespit penceresi
  engine: null, // HandControlEngine (yalnız start→stop arası)
  cursor: null, // HandCursor (koffi)
  warm: null, // { ms, delegate } — sayfa ısınma raporu
  camera: null, // { status } izin akışının son hali
  ax: null, // Erişilebilirlik güvenilir mi (darwin)
  lastFrameAt: 0,
  lastError: null,
  emergency: null, // son acil durdurma nedeni (arayüz gösterir)
  watchdog: null,
  stalledSince: 0,
  shortcutOk: null,
  startedAt: 0,
  // HAND-BUG-01 — SEÇİLEN KAMERA + adaylar. `cameraDevice` rozetin tooltip'ini
  // ve cihaz seçicisini besler; `cameraBlank` "kare akıyor ama görüntü ölü"
  // durumunun DÜRÜST göstergesidir (eski davranış: sahte yeşil).
  cameraDevice: null, // { deviceId, label, kind, dead, deadReason }
  cameraCandidates: [], // rankDevices() çıktısı (rozet seçicisi bunu listeler)
  cameraBlank: null, // { reason, label } | null
  // HAND-BUG-03 — HEDEF EKRAN. Eskiden hedef ana ekrana SABİTTİ (aşağıdaki
  // `screen.getPrimaryDisplay()`), yani el imleci harici monitöre hiç çıkamıyordu.
  targetDisplayId: null, // el imlecinin şu an sürüldüğü ekran (OS display id)
  windowDisplayId: null, // CrewPane penceresinin ekranı (taşınırsa hedef izler)
  edgeTracker: null, // handDisplayRouter.EdgeSwitchTracker (yalnız start→stop arası)
  cursorPoll: null, // gerçek fare nöbeti (kart maddesi C)
  displaysCache: null, // { at, list } — 30 Hz kare yolunda getAllDisplays çağırmamak için
  // HAND-G2 — UYGULAMA İÇİ ZOOM. Renderer hangi sekmenin önde olduğunu bilir,
  // main bilmez: her arayüz penceresi zoom'lanabilir yüzeyini buraya bildirir
  // (webContents id → 'office'|'terminal'|null). Pencere kapanınca kayıt düşer.
  zoomSurfaces: new Map(),
  // Jest BAŞINDA seçilen hedef webContents — kapanış (`end`) jest ortasında odak
  // kaysa bile AYNI pencereye gider (yoksa tuval yarı ölçekte asılı kalırdı).
  zoomTarget: null,
  // HAND-G4 — ÇALIŞAN POZ ÖRNEKLEYİCİ (aynı anda EN FAZLA BİR tane). Kare
  // yolunda beslenir; süre dolunca özet çözülür. Kamera karesi/landmark ASLA
  // girmez — örnekleyicinin kendi kapalı listesi (handPoseSampler) buna nöbet.
  sampler: null, // { sampler, resolve, timer, label }
};

// ── HAND-G2 — ZOOM YÖNLENDİRME KANCALARI (karar `handZoomRouter.cjs`'te) ─────
// Buradaki iki fonksiyon yönlendiricinin GÖZÜ ve AĞZI; karar mantığı taşımazlar.

/** Odaktaki pencere BİZİM arayüz penceremiz mi ve o sekmede zoom'lanacak bir
 *  yüzey var mı? Yoksa null → yönlendirici HAND-G1'in OS yoluna düşer.
 *  YAN ETKİ (bilerek): hedef webContents burada kilitlenir — yönlendirici bunu
 *  jest başında BİR kez çağırır, `sendZoom` o hedefi kullanır. */
function handZoomFocusedSurface() {
  handControl.zoomTarget = null;
  const win = BrowserWindow.getFocusedWindow();
  if (!win || win.isDestroyed()) return null;
  // Gizli tespit penceresi ve overlay pencereleri "arayüz" değildir.
  if (handControl.win && !handControl.win.isDestroyed() && win.id === handControl.win.id) return null;
  const surface = normalizeZoomSurface(handControl.zoomSurfaces.get(win.webContents.id));
  if (!surface) return null;
  handControl.zoomTarget = win.webContents;
  return surface;
}

/** Zoom yükünü jestin hedef penceresine ilet. false dönerse yönlendirici jesti
 *  DÜŞÜRÜR (OS yoluna kaçırmaz — aynı jest iki kanala birden inemez). */
function handZoomSend(payload) {
  const wc = handControl.zoomTarget;
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.send('handControl:zoom', payload);
    return true;
  } catch {
    return false;
  }
}

/** macOS donanım kamera listesi (Model ID = donanım kimliği, ETİKET DEĞİL).
 *  Kısa süre önbelleklenir: seçim akışı bunu aday başına değil tur başına sorar.
 *  BAŞARISIZLIK ZARARSIZ: [] dönerse politika ölçüme dayanarak yine doğru seçer. */
let handHardwareCache = { at: 0, list: [] };
const HAND_HARDWARE_TTL_MS = 30000;

function handHardwareCameras() {
  if (process.platform !== 'darwin') return [];
  const now = Date.now();
  if (now - handHardwareCache.at < HAND_HARDWARE_TTL_MS) return handHardwareCache.list;
  let list = [];
  try {
    const out = require('child_process').execFileSync('/usr/sbin/system_profiler', ['SPCameraDataType'], {
      encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024,
    });
    list = handCameraPolicy.parseSystemProfilerCameras(out);
  } catch (err) {
    logLine(`hand-control donanım kamera listesi okunamadı (zararsız): ${err.message}`);
    list = [];
  }
  handHardwareCache = { at: now, list };
  return list;
}

/** Kullanıcının AÇIK kamera seçimi (yoksa null) — ayar nöbetinden geçmiş. */
function handCameraPreference() {
  const cam = handOverlayContract.sanitizeHandControl(agentSettings.readSettings().handControl).camera;
  return cam && (cam.deviceId || cam.label) ? cam : null;
}

// ---------------------------------------------------------------------------
// HAND-BUG-03 — EL İMLECİNİN HEDEF EKRANI (çok monitör)
// ---------------------------------------------------------------------------
// Eren 03.09 canlı yayında ölçtü: "fareyi 2. harici monitöre geçiremiyorum".
// Kök neden ÖLÇÜLDÜ (docs/agent-results/HAND-BUG-03-evidence/): motorun hedefi
// `screen.getPrimaryDisplay().bounds` ile bir kez sabitleniyordu; el ekranın
// TAMAMINA eşlendiği için imleç ana ekranın dışına ÇIKAMAZDI. CGEvent'in kendisi
// suçsuzdu: harici monitörün global point dikdörtgenine (bu makinede
// -392,-1440 2560×1440) basılan olay ORAYA düşüyor — ölçüldü.
//
// Karar (Eren 02.09): tek ekrana eşleme KALIR (hassasiyet), hedef DİNAMİK olur:
//   1. başlangıç = CrewPane penceresinin ekranı,
//   2. kenar çift vuruşu = o yöndeki komşuya geç (N ekranda zincirlenir),
//   3. gerçek fare başka ekrana giderse hedef onu izler,
//   4. ekran takımı değişirse hedef yeniden çözülür.
// Geometri + FSM SAF modülde: electron/handDisplayRouter.cjs (birim testli).
const HAND_CURSOR_POLL_MS = 250; // gerçek fare + pencere ekranı nöbeti
const HAND_DISPLAYS_TTL_MS = 1000; // kare yolu 30 Hz — ekran listesi önbelleklenir

let handTargetHooked = false;

/** Ekran listesi (kısa önbellekli; ekran olaylarında düşürülür). */
function handDisplays() {
  const c = handControl;
  const now = Date.now();
  if (c.displaysCache && now - c.displaysCache.at < HAND_DISPLAYS_TTL_MS) return c.displaysCache.list;
  let list = [];
  try { list = handDisplayRouter.normalizeDisplays(screen.getAllDisplays()); } catch { list = []; }
  c.displaysCache = { at: now, list };
  return list;
}

function handControlLive() {
  const p = handControl.phase;
  return Boolean(handControl.engine) && (p === 'on' || p === 'starting' || p === 'stalled');
}

function handWindowBounds() {
  try {
    return appWindow && !appWindow.isDestroyed() ? appWindow.getBounds() : null;
  } catch { return null; }
}

/** Hedefi UYGULA: motorun eşleme dikdörtgeni + kenar sayacı sıfırlanır. */
function applyHandTargetDisplay(display, reason) {
  const c = handControl;
  if (!display || !c.engine) return false;
  const idChanged = c.targetDisplayId !== display.id;
  const boundsChanged = c.engine.setTarget(display.bounds);
  c.targetDisplayId = display.id;
  if (!idChanged && !boundsChanged) return false;
  if (c.edgeTracker) c.edgeTracker.reset();
  logLine(`hand-control hedef ekran → #${handDisplayRouter.displayOrdinal(handDisplays(), display.id)} `
    + `id=${display.id} ${display.label || ''} ${display.width}×${display.height}@${display.scaleFactor} `
    + `(${display.x},${display.y}) — ${reason}`);
  broadcastHandControlStatus();
  return true;
}

/** Ekran takımı değişti → hedefi yeniden çöz (hedef hâlâ varsa KORUNUR). */
function retargetHandDisplay(reason) {
  const c = handControl;
  c.displaysCache = null;
  if (!handControlLive()) return;
  const displays = handDisplays();
  const target = handDisplayRouter.resolveTarget(displays, {
    currentId: c.targetDisplayId,
    windowBounds: handWindowBounds(),
  });
  applyHandTargetDisplay(target, reason);
}

function hookHandTargetEvents() {
  if (handTargetHooked) return;
  handTargetHooked = true;
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(ev, () => retargetHandDisplay(`ekran takımı değişti (${ev})`));
  }
}

/**
 * Kare yolundaki kenar-vuruşu nöbeti. İmlecin GÖRÜNEN konumundan (engine.lastCursor)
 * çalışır; ürettiği olaylar A1 sözleşmesinin `edge` olaylarıdır ve overlay'in
 * durum 19 çizimini (bant + "1/2 · sağ" çipi + "→ Ekran 2") besler.
 * @returns {object[]} overlay olayları
 */
function updateHandEdgeSwitch() {
  const c = handControl;
  if (!c.engine || !c.edgeTracker) return [];
  const displays = handDisplays();
  const display = handDisplayRouter.displayById(displays, c.targetDisplayId);
  if (!display) return [];
  const lc = c.engine.lastCursor;
  const res = c.edgeTracker.update({
    point: lc ? { x: lc[0], y: lc[1] } : null,
    display,
    displays,
    now: Date.now(),
    handPresent: c.engine.handPresent,
  });
  if (res.switchTo) {
    applyHandTargetDisplay(handDisplayRouter.displayById(displays, res.switchTo), 'kenar vuruşu (durum 19)');
  }
  return res.events;
}

/** Gerçek fare + pencere ekranı nöbeti (kart maddeleri C ve "pencere move"). */
function startHandCursorPoll() {
  stopHandCursorPoll();
  handControl.cursorPoll = setInterval(() => {
    const c = handControl;
    if (!handControlLive()) return;
    const displays = handDisplays();
    if (displays.length < 2) return; // tek ekranda yapacak iş yok
    // (a) CrewPane penceresi başka ekrana taşındı mı?
    const wd = handDisplayRouter.displayForBounds(displays, handWindowBounds());
    if (wd && wd.id !== c.windowDisplayId) {
      c.windowDisplayId = wd.id;
      applyHandTargetDisplay(wd, 'CrewPane penceresi bu ekrana taşındı');
      return;
    }
    // (b) Kullanıcı FİZİKSEL fareyi başka ekrana götürdü mü? (bizim ürettiğimiz
    //     imleç olayları sayılmaz — followRealCursor lastPos ile ayırır.)
    let point = null;
    try { point = screen.getCursorScreenPoint(); } catch { return; }
    const next = handDisplayRouter.followRealCursor({
      point,
      lastApplied: c.cursor ? c.cursor.lastPos : null,
      displays,
      currentId: c.targetDisplayId,
    });
    if (next) applyHandTargetDisplay(handDisplayRouter.displayById(displays, next), 'gerçek fare o ekrana taşındı');
  }, HAND_CURSOR_POLL_MS);
  if (handControl.cursorPoll.unref) handControl.cursorPoll.unref();
}

function stopHandCursorPoll() {
  if (handControl.cursorPoll) clearInterval(handControl.cursorPoll);
  handControl.cursorPoll = null;
}

function handControlStatus() {
  const c = handControl;
  return {
    phase: c.phase,
    warm: c.warm,
    camera: c.camera,
    ax: c.ax,
    cursor: c.cursor ? c.cursor.info : (c.engine ? c.engine.cursor.info : null),
    shortcut: { accelerator: HAND_SHORTCUT, registered: c.shortcutOk },
    // HAND-BUG-01 — hangi kamera açık, adaylar neler, görüntü ölü mü.
    cameraDevice: c.cameraDevice,
    cameraCandidates: c.cameraCandidates,
    cameraBlank: c.cameraBlank,
    cameraPreference: handCameraPreference(),
    // HAND-BUG-03 — imleç HANGİ ekranda sürülüyor (rozet/öğretici + kanıt).
    targetDisplay: (() => {
      const list = handDisplays();
      const d = handDisplayRouter.displayById(list, c.targetDisplayId);
      if (!d) return null;
      return {
        id: d.id,
        index: handDisplayRouter.displayOrdinal(list, d.id),
        label: d.label,
        internal: d.internal,
        bounds: d.bounds,
        scaleFactor: d.scaleFactor,
      };
    })(),
    displayCount: handDisplays().length,
    fps: c.engine ? c.engine.fps : 0,
    // HAND-G7 — hayalet el kalkanının sağlık sayacı: akıl sağlığı sınırından
    // (aspect > 6) dönen kare sayısı + son ölçülen oran. "El kontrolü tuhaf
    // davranıyor" şikâyetinde İLK bakılacak sayı budur.
    garbageFrames: c.engine ? c.engine.garbageFrames : 0,
    lastAspect: c.engine ? c.engine.lastAspect : null,
    // HAND-G2 — zoom NEREYE gitti: `surfaces` pencerelerin bildirdiği yüzeyler,
    // `routed` kaç jestin uygulama içi (app) / OS yoluna düştüğü. "Zoom
    // çalışmıyor" şikâyetinde ilk bakılacak sayı: routed.os yükseliyorsa jest
    // ÇALIŞIYOR ama uygulama içi yüzey bulunamıyor demektir.
    zoom: {
      surfaces: Array.from(handControl.zoomSurfaces.values()),
      routed: c.zoomRouter ? { ...c.zoomRouter.routed } : null,
      // OS yoluna basılan toplam CGEvent sayısı (imlecin kendi sayacı) — "zoom
      // OS'a GERÇEKTEN indi mi" sorusunun iddia değil ÖLÇÜM cevabı.
      posted: c.cursor ? c.cursor.posted : null,
      // HAND-G3 — iki-el zoom jesti BU DONANIMDA mümkün mü. `false` ise ayar
      // açık olsa bile jest doğmaz: model tek el görüyor (CPU yedeği kapısı).
      twoHandPossible: c.warm && c.warm.numHands != null ? c.warm.numHands >= 2 : null,
    },
    // HAND-G4 — CANLI JEST SÖZLÜĞÜ: o anki kapı metrikleri + mandallı kanal.
    // Kullanıcı "neden tıklıyor / neden zoom yapıyor" sorusunu kendi
    // cevaplayabilsin diye rozet bunları gösterebilir.
    pose: c.engine ? { metrics: handPoseMetrics(), channel: handPoseChannel() } : null,
    // HAND-G3 (Y3) — SOL BUTON ŞU AN BASILI MI. En kötü arıza sınıfı "asılı
    // mouse-down"dur: bırakılmazsa sonraki HER hareket sürüklemeye döner.
    // İki-el jesti devralırken tek-el kanalı susturulur ve buton bırakılır;
    // bunun iddia değil ÖLÇÜ olması için imlecin kendi durumu yayınlanır.
    dragging: c.cursor ? c.cursor.dragging : null,
    lastFrameAt: c.lastFrameAt || null,
    startedAt: c.startedAt || null,
    emergency: c.emergency,
    error: c.lastError,
  };
}

function broadcastHandControlStatus() {
  const st = handControlStatus();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.webContents.send('handControl:status', st);
    } catch { /* kapanan pencere yarışı zararsız */ }
  }
  return st;
}

function handDetectAlive() { return windowManager.handDetectAlive(); }
function openHandDetectWindow() { return windowManager.openHandDetectWindow(); }
function scheduleHandControlWarmup(attempt = 0) { return windowManager.scheduleHandControlWarmup(attempt); }

/** Kamera izni — R1 §5.1 SIRASI: main'de askForMediaAccess ÖNCE (motor değil;
 *  ilk-çağrı kaybı R1 §2.2), ret'te deep-link. TR metin builder extendInfo'da. */
async function ensureCameraAccess() {
  if (process.platform !== 'darwin') {
    // Windows: getMediaAccessStatus global anahtarı okur; istem yolu v1'de yok
    // (K14: kapalıysa getUserMedia 'Could not start video source' verir).
    const st = systemPreferences.getMediaAccessStatus ? systemPreferences.getMediaAccessStatus('camera') : 'unknown';
    return { ok: st !== 'denied', status: st, settingsUrl: process.platform === 'win32' ? 'ms-settings:privacy-webcam' : null };
  }
  const before = systemPreferences.getMediaAccessStatus('camera');
  if (before === 'granted') return { ok: true, status: 'granted' };
  if (before === 'not-determined') {
    const granted = await systemPreferences.askForMediaAccess('camera');
    return { ok: granted, status: granted ? 'granted' : 'denied', asked: true };
  }
  // denied/restricted: istem BİR DAHA çıkmaz (K4) — kullanıcıyı ayara götür.
  return {
    ok: false,
    status: before,
    settingsUrl: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  };
}

function registerHandShortcut() {
  try {
    handControl.shortcutOk = globalShortcut.register(HAND_SHORTCUT, () => {
      emergencyStopHandControl('kısayol ⌘⇧H');
    });
  } catch (err) {
    handControl.shortcutOk = false;
    handControl.lastError = `kısayol: ${err.message}`;
  }
  // Sessiz başarısızlık YOK (R1 §5.3): sonuç loglanır + status taşır.
  logLine(`hand-control kısayol '${HAND_SHORTCUT}' registered=${handControl.shortcutOk}`);
}

function unregisterHandShortcut() {
  try { globalShortcut.unregister(HAND_SHORTCUT); } catch { /* kayıtlı değilse zararsız */ }
  handControl.shortcutOk = null;
}

/** El kontrolünü BAŞLAT: izinler → kamera → motor. Rozet ancak ilk kare
 *  aktığında 'on' olur (dürüstlük: ısınma + getUserMedia süresi görünür). */
async function startHandControl() {
  const c = handControl;
  if (c.phase === 'on' || c.phase === 'starting') return { ok: true, already: true, status: handControlStatus() };
  c.emergency = null;
  c.lastError = null;

  // İmleç arka ucu bu platformda yoksa başlatma — sessiz ölüm yasak.
  // HAND-BUG-02: her buton olayı loglanır (pinch tık kaybı ancak bu izle
  // ayrıştırılabildi — basılan pos + görünür imleç pos + dragging + ok).
  // HAND-G1 — zoom değiştiricisi AYARDAN (⌘ varsayılan · ⌃ = macOS
  // Erişilebilirlik Yakınlaştırma). Nöbet sanitizeHandControl'de.
  const handPrefs = handOverlayPrefs();
  let HandCursorClass = HandCursor;
  try {
    const { HandCursor: FreshHandCursor } = require('./src/hand/handCursor.cjs');
    HandCursorClass = FreshHandCursor;
  } catch {}
  const cursor = new HandCursorClass(null, {
    onEvent: (e) => logLine(`hand-cursor ${JSON.stringify(e)}`),
    zoomModifier: handPrefs.zoom.modifier,
  });
  if (!cursor.available) {
    c.lastError = `imleç arka ucu yok: ${cursor.info.error || cursor.info.platform}`;
    broadcastHandControlStatus();
    return { ok: false, error: c.lastError, status: handControlStatus() };
  }
  if (!cursor.info.verified) {
    // Windows SendInput iskeleti ÖLÇÜLMEDİ — üretimde açılmaz (kart beyanı).
    c.lastError = `imleç arka ucu '${cursor.info.platform}' bu makinede doğrulanmadı`;
    broadcastHandControlStatus();
    return { ok: false, error: c.lastError, status: handControlStatus() };
  }

  const cam = await ensureCameraAccess();
  c.camera = cam;
  if (!cam.ok) {
    broadcastHandControlStatus();
    return { ok: false, error: `kamera izni: ${cam.status}`, camera: cam, status: handControlStatus() };
  }

  // Erişilebilirlik: ASLA önce false ile çağrılmaz (Electron #28395 — false
  // sonrası istem bir daha çıkmaz). Güvenilir değilse BİLDİRİR ama durmaz:
  // CGEventPost bazı kurulumlarda izinsiz de çalışır; arayüz göstergesi taşır.
  if (process.platform === 'darwin') {
    try { c.ax = systemPreferences.isTrustedAccessibilityClient(true); } catch { c.ax = null; }
  }

  const opened = openHandDetectWindow();
  if (!opened.ok) {
    c.lastError = opened.error;
    broadcastHandControlStatus();
    return { ok: false, error: opened.error, status: handControlStatus() };
  }

  c.cursor = cursor;
  // HAND-BUG-03 — BAŞLANGIÇ HEDEFİ = CrewPane penceresinin ekranı (ana ekran
  // DEĞİL). Eren harici monitörde çalışırken el imleci laptop ekranında
  // doğuyordu; kusurun ilk yarısı bu satırdı.
  c.displaysCache = null;
  const displays = handDisplays();
  const startTarget = handDisplayRouter.displayForBounds(displays, handWindowBounds())
    || handDisplayRouter.normalizeDisplays([screen.getPrimaryDisplay()])[0];
  c.targetDisplayId = startTarget ? startTarget.id : null;
  c.windowDisplayId = c.targetDisplayId;
  c.edgeTracker = new handDisplayRouter.EdgeSwitchTracker();
  // HAND-G2 — motor artık ham imleci DEĞİL yönlendiriciyi görür: zoom aksiyonu
  // CrewPane öndeyse IPC'ye, değilse HAND-G1'in ⌘/⌃+tekerlek yoluna gider.
  // Diğer aksiyonlar (move/tık/scroll) dokunulmadan imlece iner.
  c.zoomRouter = new ZoomRouter({ cursor, focusedSurface: handZoomFocusedSurface, sendZoom: handZoomSend });
  c.engine = new HandControlEngine({
    cursor: c.zoomRouter,
    // DIP = macOS global point (R1 §5.2) — ÖLÇÜLDÜ: Electron display.bounds ile
    // CGDisplayBounds birebir aynı (negatif koordinatlı harici monitörde de).
    target: startTarget ? startTarget.bounds : screen.getPrimaryDisplay().bounds,
    // HAND-G1 — zoom AYARDAN: `oneHand` tek-el kanalı (varsayılan KAPALI),
    // `twoHand` iki-el jesti (varsayılan AÇIK). `enabled` ikisinin ana şalteri.
    // HAND-G4 — AYAR KLİNİĞİ EŞİKLERİ. Yalnız DOLU alanlar geçirilir: `null`
    // "kullanıcı dokunmadı" demektir ve motorun kendi varsayılanı kalır (sayıyı
    // burada kopyalamak ikinci bir gerçek üretirdi).
    fsmConfig: { zoomEnabled: handPrefs.zoom.enabled && handPrefs.zoom.oneHand, ...handTuningConfig(handPrefs) },
    twoHandConfig: { enabled: handPrefs.zoom.enabled && handPrefs.zoom.twoHand },
  });
  c.phase = 'starting';
  c.startedAt = Date.now();
  c.cameraDevice = null;
  c.cameraBlank = null;
  c.win.webContents.send('handDetect:command', { cmd: 'start-camera' });
  registerHandShortcut();
  startHandWatchdog();
  hookHandTargetEvents();
  startHandCursorPoll();
  broadcastHandControlStatus();
  logLine(`hand-control BAŞLATILDI (kamera isteniyor) — hedef ekran #`
    + `${handDisplayRouter.displayOrdinal(displays, c.targetDisplayId)}/${displays.length} `
    + `id=${c.targetDisplayId} ${startTarget ? startTarget.label : ''}`);
  return { ok: true, status: handControlStatus() };
}

/** HAND-BUG-01 — kullanıcının kamera seçimini KALICI yaz ve anında uygula.
 *  `sel` null/boş → otomatik seçime dön (politika karar verir). */
function selectHandCamera(sel) {
  const deviceId = sel && typeof sel.deviceId === 'string' ? sel.deviceId : null;
  const label = sel && typeof sel.label === 'string' ? sel.label : null;
  // Kapalı-liste nöbeti agentSettings/sanitizeHandControl'da; burada yalnız
  // "seçilen cihaz gerçekten listede mi" kapısı var (renderer çöp yazamasın).
  if (deviceId && handControl.cameraCandidates.length
      && !handControl.cameraCandidates.some((c) => c.deviceId === deviceId)) {
    return { ok: false, error: 'bilinmeyen kamera' };
  }
  agentSettings.writeSettings({ handControl: { camera: { deviceId, label } } });
  logLine(`hand-control kamera seçimi: ${label || deviceId || '(otomatik)'}`);
  // Motor açıksa kamerayı yeniden aç — seçim ANINDA görünür olsun.
  const live = handControl.phase === 'on' || handControl.phase === 'starting' || handControl.phase === 'stalled';
  if (live && handDetectAlive()) {
    handControl.cameraBlank = null;
    try {
      handControl.win.webContents.send('handDetect:command', { cmd: 'stop-camera' });
      handControl.win.webContents.send('handDetect:command', { cmd: 'start-camera' });
    } catch { /* pencere kapanıyor: bir sonraki başlatmada zaten uygulanır */ }
  }
  broadcastHandControlStatus();
  return { ok: true, selected: { deviceId, label }, restarted: live };
}

/** DURDUR: kamera kapanır (ışık söner), buton bırakılır, kısayol çözülür.
 *  Pencere SICAK kalır (warm) — yeniden başlatma anlıktır; kaynak: yalnız
 *  boşta bir gizli sayfa (rAF durmuş, kamera yok). */
function stopHandControl(reason) {
  const c = handControl;
  const wasActive = c.phase === 'on' || c.phase === 'starting' || c.phase === 'stalled';
  if (c.engine) c.engine.halt(); // basılı buton MUTLAKA bırakılır
  if (handDetectAlive()) {
    try { c.win.webContents.send('handDetect:command', { cmd: 'stop-camera' }); } catch { /* pencere kapanıyor */ }
  }
  stopHandWatchdog();
  unregisterHandShortcut();
  stopHandCursorPoll(); // HAND-BUG-03
  c.engine = null;
  c.cursor = null;
  c.zoomRouter = null; // HAND-G2 — kilitli rota jestle birlikte ölür
  c.zoomTarget = null;
  c.edgeTracker = null;
  c.targetDisplayId = null;
  c.windowDisplayId = null;
  c.phase = handDetectAlive() && c.warm ? 'warm' : (handDetectAlive() ? 'warming' : 'off');
  c.startedAt = 0;
  c.lastFrameAt = 0;
  c.cameraDevice = null; // HAND-BUG-01 — bayat cihaz adı rozette asılı kalmasın
  c.cameraBlank = null;
  if (wasActive) logLine(`hand-control durdu (${reason || 'istek'})`);
  broadcastHandControlStatus();
  return { ok: true, stopped: wasActive };
}

/** ACİL DURDURMA — imleç sürülürken bile: FSM/imleç zinciri ANINDA kesilir
 *  (engine.halt basılı butonu bırakır), overlay bekçisi 2 sn'de kendini kapatır. */
function emergencyStopHandControl(reason) {
  handControl.emergency = reason || 'acil durdurma';
  const r = stopHandControl(`ACİL: ${reason}`);
  broadcastHandControlStatus();
  return r;
}

function startHandWatchdog() {
  stopHandWatchdog();
  handControl.watchdog = setInterval(() => {
    const c = handControl;
    if (c.phase !== 'on' && c.phase !== 'stalled') return;
    const silent = Date.now() - (c.lastFrameAt || c.startedAt);
    if (silent > HAND_STALL_MS) {
      if (c.phase === 'on') {
        c.phase = 'stalled';
        c.stalledSince = Date.now();
        broadcastHandControlStatus();
        logLine(`hand-control: motor ${silent} ms sessiz → stalled`);
      } else if (Date.now() - c.stalledSince > HAND_STALL_STOP_MS) {
        stopHandControl('motor sessiz kaldı'); // R1 §5.3-3: stop dener
      }
    } else if (c.phase === 'stalled') {
      c.phase = 'on'; // akış geri geldi
      broadcastHandControlStatus();
    }
  }, 1000);
  if (handControl.watchdog.unref) handControl.watchdog.unref();
}

function stopHandWatchdog() {
  if (handControl.watchdog) clearInterval(handControl.watchdog);
  handControl.watchdog = null;
}

/** Tespit penceresinden gelen kare — SADECE o pencereden kabul edilir
 *  (başka renderer imleç süremez; A1 riski #5'in kapısı). */
// ── HAND-G4 — POZ ÖRNEKLEYİCİ (jest sözlüğü / ayar kliniği) ────────────────
// "Benim elimde çalışmıyor" sınıfının çözümü eşik oynatmak değil ÖLÇÜM ARACIDIR.
// Metrikler motorun SON KARE tanısından okunur (`lastFrameDbg` — türetilmiş
// sayılar; kamera karesi main'e zaten hiç gelmez, R1 §5.4).

/** Motorun son karesinden kapı metriklerini çıkar (tek yer: hem örnekleyici
 *  hem canlı jest sözlüğü buradan okur — iki gerçek olmasın). */
function handPoseMetrics() {
  const c = handControl;
  if (!c.engine) return null;
  const f = c.engine.lastFrameDbg;
  if (!f || !f.hand) return { hand: false, fps: c.engine.fps, aspect: c.engine.lastAspect };
  return {
    hand: true,
    pinchIndex: f.pinchIndex,
    pinchMiddle: f.pinchMiddle,
    pinky: f.pinky,
    scale: f.scale,
    backMean: f.backMean,
    indexArch: f.indexArch,
    aspect: c.engine.lastAspect,
    twoFingers: f.twoFingers,
    fps: c.engine.fps,
  };
}

/** ŞU AN hangi kanal mandallı — jest sözlüğü panelinin canlı satırı. FSM'in
 *  kendi durumundan OKUNUR, burada yeniden hesaplanmaz (tek gerçek). */
function handPoseChannel() {
  const c = handControl;
  if (!c.engine || !c.engine.fsm) return null;
  const fsm = c.engine.fsm;
  return {
    state: c.engine.lastState,
    // Kanal mandalı: zoom kanalı açıkken tık/sürükle üretilmez ve tersi.
    zoomChannel: Boolean(fsm._zoomChannel),
    precision: Boolean(fsm.precision),
    twoHandActive: Boolean(c.engine.twoHand && c.engine.twoHand.active),
  };
}

function feedPoseSampler() {
  const box = handControl.sampler;
  if (!box) return;
  const m = handPoseMetrics();
  if (m && m.hand) box.sampler.push(m);
  else box.emptyFrames += 1;
  if (box.sampler.done) finishPoseSampler();
}

function finishPoseSampler() {
  const box = handControl.sampler;
  if (!box) return;
  handControl.sampler = null;
  if (box.timer) clearTimeout(box.timer);
  const summary = box.sampler.summary();
  logLine(`hand-pose örnek '${box.label}': ${summary.frames} kare · elsiz ${box.emptyFrames} · metrik ${Object.keys(summary.metrics).length}`);
  box.resolve({ ok: true, label: box.label, emptyFrames: box.emptyFrames, ...summary });
}

function onHandDetectFrame(event, payload) {
  const c = handControl;
  if (!handDetectAlive() || event.sender !== c.win.webContents) return;
  if (!c.engine || (c.phase !== 'on' && c.phase !== 'starting' && c.phase !== 'stalled')) return;
  const first = c.phase !== 'on';
  c.lastFrameAt = Date.now();
  try {
    const out = c.engine.onFrame(payload || {});
    // HAND-G4 — örnekleyici çalışıyorsa BU karenin kapı metriklerini al.
    if (c.sampler) feedPoseSampler();
    // HAND-BUG-03 — kenar vuruşu nöbeti kare yolunda koşar (imlecin GÖRÜNEN
    // konumundan) ve durum 19 olaylarını aynı overlay akışına katar.
    const edgeEvents = updateHandEdgeSwitch();
    const overlayEvents = edgeEvents.length ? out.overlayEvents.concat(edgeEvents) : out.overlayEvents;
    if (overlayEvents.length) {
      try { feedHandOverlay(overlayEvents); } catch { /* overlay kapalı olabilir */ }
    }
  } catch (err) {
    c.lastError = `kare işleme: ${err.message}`;
    logLine(`hand-control kare hatası: ${err.message}`);
  }
  if (first && c.phase === 'starting') {
    c.phase = 'on'; // İLK kare aktı: rozet ancak şimdi yeşil (dürüst "Açık")
    broadcastHandControlStatus();
    logLine('hand-control AÇIK — ilk tespit karesi aktı');
  }
}

function createSpikeWindow() { return windowManager.createSpikeWindow(); }

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// ─────────────────────────────────────────────────────────────────────────────
// ADP-533 + ADP-553 — güncelleme akışı, TEK durum makinesi iki modla:
//
//   mode:'updater' (Faz 2, ADP-553) — imzalı+notarize edilmiş PAKETLİ build:
//     electron-updater latest-mac.yml'i okur (publish: github, prod-builder.cjs) →
//     rozet "İndir" = uygulama İÇİNDE indirme (progress) → "Yeniden başlat ve
//     güncelle" = kullanıcı ONAYIYLA quitAndInstall. Sessiz zorlama YOK
//     (autoDownload=false; indirme ve kurulum yalnız kullanıcı tıklamasıyla).
//   mode:'notify'  (Faz 1, ADP-533) — dev/unsigned fallback: GitHub Releases API
//     sürüm karşılaştırır, "İndir" SABİT DMG URL'ini tarayıcıda açar.
//
// Her iki modda: açılışta + ~6 saatte bir kontrol; ağ/limit hatası SESSİZ geçilir
// (bildirim yok, çökme yok); ✕ = sürüm-bazlı kalıcı dismiss. `update:*` IPC yüzeyi
// iki modda AYNI — renderer mode+phase'e göre buton etiketini seçer.
let updateState = {
  checked: false,
  updateAvailable: false,
  latestVersion: null,
  lastCheckedAt: null,
  // ADP-553 — updater yaşam döngüsü: idle → available → downloading → downloaded.
  phase: 'idle',
  progressPercent: null,
  // ADP-620 — notify modunda kanala göre hesaplanan indirme adresi (null → sabit
  // stable adresi). Updater modunda kullanılmaz (indirme uygulama içinde).
  downloadUrl: null,
};

// electron-updater köprüsü (null = Faz 1 notify fallback'i).
let autoUpdaterRef = null;

/**
 * ADP-620 — bu koşunun dinlediği yayın kanalı ('stable' | 'beta').
 * Müşteri (paketli prod instance, ayar yok) → stable: beta release'leri GÖRMEZ.
 * Ayarlar'daki "Beta güncellemeleri al" toggle'ı ya da dev instance → beta.
 * Her kontrolden önce yeniden çözülür → toggle restart İSTEMEZ.
 */
function currentUpdateChannel() {
  return updateChannel.resolveChannel({
    settingsValue: agentSettings.readSettings().updateChannel,
    instanceId: instancePaths.instanceId(),
    envValue: process.env.CREWPANE_UPDATE_CHANNEL || null,
  });
}

/**
 * electron-updater'ı yalnız ÇALIŞABİLECEĞİ yerde başlat:
 * - paketli app + Resources/app-update.yml (publish config'li prod build), veya
 * - CREWPANE_UPDATE_CONFIG=<yml> e2e/dev dikişi (forceDevUpdateConfig).
 * Aksi halde null → Faz 1 notify akışı sürer. Hata = sessiz fallback.
 */
function initAutoUpdater() {
  try {
    const devConfig = process.env.CREWPANE_UPDATE_CONFIG || null;
    if (!devConfig) {
      if (!app.isPackaged) return null; // dev'de Faz 1 (notify) akışı
      // dev/test DMG'lerinde publish config yok → app-update.yml paketlenmez.
      if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return null;
    }
    const { autoUpdater } = require('electron-updater');
    if (devConfig) {
      autoUpdater.updateConfigPath = devConfig;
      autoUpdater.forceDevUpdateConfig = true;
    }
    autoUpdater.autoDownload = false; // indirme yalnız kullanıcı "İndir" deyince
    autoUpdater.autoInstallOnAppQuit = true; // indirilmişse normal çıkışta kurulur (zorlama değil)
    // ADP-620 — KANAL: stable istemci allowPrerelease=false ile koşar → GitHub'ın
    // /releases/latest'i prerelease'leri atladığı için beta release'i GÖREMEZ.
    // (Kanal PAKETE gömülmez — app-update.yml'de `channel:` yok; bkz. updateChannel.cjs.)
    logLine(`updater: yayın kanalı = ${updateChannel.applyChannel(autoUpdater, currentUpdateChannel())}`);
    autoUpdater.logger = {
      info: (m) => logLine(`updater: ${m}`),
      warn: (m) => logLine(`updater[warn]: ${m}`),
      error: (m) => logLine(`updater[error]: ${m}`),
      debug: () => {},
    };
    autoUpdater.on('update-available', (info) => {
      updateState = {
        ...updateState,
        checked: true,
        updateAvailable: true,
        latestVersion: `v${info.version}`, // Faz 1 tag biçimiyle aynı (dismiss uyumu)
        lastCheckedAt: Date.now(),
        phase: updateState.phase === 'downloaded' ? 'downloaded' : 'available',
      };
      logLine(`update-check(updater): yeni sürüm var → v${info.version}`);
      noteUpdateResult('ok', `v${info.version}`); // ADP-845
      pushUpdateState();
    });
    autoUpdater.on('update-not-available', (info) => {
      updateState = {
        ...updateState,
        checked: true,
        updateAvailable: false,
        latestVersion: info && info.version ? `v${info.version}` : updateState.latestVersion,
        lastCheckedAt: Date.now(),
        phase: 'idle',
        progressPercent: null,
      };
      logLine('update-check(updater): güncel');
      noteUpdateResult('no-update', info && info.version ? `v${info.version}` : null); // ADP-845
      pushUpdateState();
    });
    autoUpdater.on('download-progress', (p) => {
      updateState = { ...updateState, phase: 'downloading', progressPercent: Math.round(p.percent) };
      pushUpdateState();
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateState = {
        ...updateState,
        phase: 'downloaded',
        progressPercent: 100,
        latestVersion: `v${info.version}`,
      };
      logLine(`updater: v${info.version} indirildi — kullanıcı onayı bekleniyor (Yeniden başlat)`);
      pushUpdateState();
    });
    autoUpdater.on('error', (err) => {
      // Sessizlik sözleşmesi (ADP-533 ile aynı): ağ/feed hatası bildirim üretmez,
      // app'i düşürmez; yarım indirme durumu geri 'available'a alınır.
      logLine(`update-check(updater): sessiz geçildi (${err && err.message ? err.message.split('\n')[0] : 'error'})`);
      // ADP-845 — HATA METNİ GİTMEZ, yalnız SINIFI. Metin URL/yol taşıyabilir.
      noteUpdateResult(/403/.test(String(err && err.message)) ? 'http-403' : 'network', null);
      if (updateState.phase === 'downloading') {
        updateState = { ...updateState, phase: 'available', progressPercent: null };
        pushUpdateState();
      }
    });
    return autoUpdater;
  } catch (err) {
    logLine(`updater init başarısız → Faz 1 notify fallback (${err && err.message})`);
    return null;
  }
}

/**
 * LIC-ENFORCE-01 — güncelleme kanalının lisans kapısı (tek çağrı noktası).
 * Karar `updateCheck.updateLicenseGate` içinde; burada YALNIZ seatGate'in
 * anlık snapshot'ı verilir. seatGate yoksa kapı AÇIK sayılır: bir başlatma
 * sırası detayı güncelleme kanalını sessizce kapatmamalı.
 */
function updateLicenseGateNow() {
  try {
    return updateCheck.updateLicenseGate(seatGate ? seatGate.state() : null);
  } catch (e) {
    logLine(`update-gate: değerlendirilemedi (${e && e.message}) — kanal AÇIK bırakıldı`);
    return { allowed: true };
  }
}

/** Renderer'a giden görünüm: durum + kurulu sürüm + toggle + sürüm-bazlı dismiss. */
function updateStateForRenderer() {
  const s = agentSettings.readSettings();
  const gate = updateLicenseGateNow();
  return {
    ...updateState,
    currentVersion: app.getVersion(),
    // LIC-ENFORCE-01 — "neden güncelleme gelmiyor?" sorusunun cevabı VERİ olarak
    // taşınır; kapı kapalıyken hiçbir yerde "güncel" YALANI kurulmaz.
    licenseBlocked: gate.allowed === false,
    licenseMessage: gate.allowed === false ? gate.message : null,
    licenseBillingUrl: gate.allowed === false ? (gate.billingUrl || null) : null,
    autoCheck: s.updateAutoCheck !== false,
    // "Bu sürüm için sonra": dismiss sürüme bağlıdır — daha yeni bir sürüm çıkınca
    // otomatik geçersizleşir (settings.updateDismissedVersion ≠ yeni tag).
    dismissed: !!(updateState.latestVersion && s.updateDismissedVersion === updateState.latestVersion),
    // ADP-620 — notify modunda beta kanalın indirme adresi tag'e bağlıdır (stable'ın
    // sabit `releases/latest/download/…` adresi beta'yı ASLA göstermez).
    downloadUrl: updateState.downloadUrl || updateCheck.DOWNLOAD_URL,
    // ADP-553 — renderer buton etiketini moda göre seçer (uygulama-içi indirme vs tarayıcı).
    mode: autoUpdaterRef ? 'updater' : 'notify',
    // ADP-620 — hangi kanaldan güncelleniyoruz + Ayarlar toggle'ının durumu.
    channel: currentUpdateChannel(),
    channelPref: updateChannel.normalizeChannel(s.updateChannel) || 'auto',
  };
}

function pushUpdateState() {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send('update:state', updateStateForRenderer());
    } catch { /* best-effort */ }
  }
}

/** Kontrolü koş; HER hata yolu sessiz (checkForUpdate throw etmez). Dönen değer IPC cevabı. */
async function runUpdateCheck(trigger) {
  if (trigger === 'auto' && agentSettings.readSettings().updateAutoCheck === false) {
    return updateStateForRenderer();
  }
  // LIC-ENFORCE-01 — LİSANS KAPISI, AĞ ÇAĞRISINDAN ÖNCE. Sunucu bu hesabın
  // erişimini kapattıysa yeni sürüm ne SORULUR ne İNDİRİLİR. Kurulu sürüm
  // çalışmaya devam eder; çevrimdışı/bilinmeyen durumda kapı AÇIKTIR (sessiz geçiş).
  const gate = updateLicenseGateNow();
  if (!gate.allowed) {
    logLine(`update-check(${trigger}): LİSANS KAPISI (${gate.reason}) — yeni sürüm sorulmadı/indirilmedi`);
    pushUpdateState();
    return updateStateForRenderer();
  }
  // ADP-553 — updater modu: kontrolü electron-updater yapar (latest-mac.yml);
  // sonuç event'lerle updateState'e düşer. Hata sessiz (error handler'ı loglar).
  const channel = currentUpdateChannel();
  if (autoUpdaterRef) {
    // ADP-620 — kanalı HER kontrolde yeniden uygula: Ayarlar'daki toggle restart
    // beklemeden etki etsin (applyChannel idempotent + allowDowngrade'i geri alır).
    updateChannel.applyChannel(autoUpdaterRef, channel);
    try { await autoUpdaterRef.checkForUpdates(); } catch { /* sessiz — error event'i logladı */ }
    return updateStateForRenderer();
  }
  // Faz 1 (notify): CREWPANE_UPDATE_FEED_URL = e2e dikişi; normalde GitHub API
  // (kanala göre uç nokta seçimi updateCheck'te — stable yol değişmedi).
  const res = await updateCheck.checkForUpdate({
    currentVersion: app.getVersion(),
    channel,
    url: process.env.CREWPANE_UPDATE_FEED_URL || null,
  });
  if (res.ok) {
    updateState = {
      ...updateState,
      checked: true,
      updateAvailable: res.updateAvailable,
      latestVersion: res.latestVersion,
      lastCheckedAt: Date.now(),
      phase: res.updateAvailable ? 'available' : 'idle',
      downloadUrl: res.downloadUrl || null, // ADP-620 — kanala göre indirme adresi
    };
    logLine(`update-check(${trigger},${res.channel || channel}): latest=${res.latestVersion} current=${res.currentVersion} → ${res.updateAvailable ? 'yeni sürüm var' : 'güncel'}`);
    noteUpdateResult(res.updateAvailable ? 'ok' : 'no-update', res.latestVersion); // ADP-845
    pushUpdateState();
  } else {
    logLine(`update-check(${trigger}): sessiz geçildi (${res.reason})`);
    noteUpdateResult(res.reason, null); // ADP-845
  }
  return updateStateForRenderer();
}

/**
 * ADP-845 — güncelleme kontrolünün sonucunu heartbeat'e işle (ADP-805 §4).
 * Bugün bu bilgi YALNIZ müşterinin kendi diskindeki log'a yazılıyor; "müşteri 3
 * haftadır eski sürümde çünkü feed 403 veriyor" vakası bize hiç ulaşmıyor.
 *
 * ⚠️ Serbest metin GİTMEZ: `updateCheck.cjs`'in reason'ı sabit kümeye eşlenir,
 * eşleşmeyen her şey 'error' olur (heartbeat.cjs zaten ikinci kez süzer).
 */
function noteUpdateResult(reason, latestVersion) {
  const r = String(reason || '');
  const result = r === 'ok' || r === 'no-update' || r === 'timeout' || r === 'network' || r === 'bad-payload'
    ? r
    : (r.startsWith('http-') ? (r === 'http-403' ? 'http-403' : 'network') : 'error');
  try {
    heartbeat().noteUpdate({ result, checkedAt: Date.now(), latestSeen: latestVersion || null });
  } catch { /* telemetri asla güncelleme akışını düşürmez */ }
}

let updateChecksScheduled = false;
function scheduleUpdateChecks() {
  if (updateChecksScheduled) return;
  updateChecksScheduled = true;
  autoUpdaterRef = initAutoUpdater(); // ADP-553 — mod seçimi (updater | notify)
  // Test instance'ında feed dikişi yoksa OTOMATİK kontrol yok: e2e filosunun her app
  // açılışı GitHub API'ye vurup rate-limit'e (60/saat/IP) takılmasın; güncelleme
  // spec'i CREWPANE_UPDATE_FEED_URL / CREWPANE_UPDATE_CONFIG ile kendi mock
  // sunucusunu verir.
  if (
    instancePaths.instanceId() === 'test' &&
    !process.env.CREWPANE_UPDATE_FEED_URL &&
    !process.env.CREWPANE_UPDATE_CONFIG
  ) return;
  // Kısa gecikme: açılışın kritik yolu (Next server + pencere) ile yarışmasın.
  setTimeout(() => { runUpdateCheck('auto').catch(() => {}); }, 2500);
  const timer = setInterval(() => { runUpdateCheck('auto').catch(() => {}); }, updateCheck.CHECK_INTERVAL_MS);
  timer.unref?.();
}

// ---------------------------------------------------------------------------
// ADP-675 — UYGULAMA-İÇİ DUYURU (announcements). Güncelleme kontrolüyle AYNI iskelet:
// main çeker → durumu tutar → renderer'a push'lar; ağ hatası SESSİZ (çökme yok).
// Fark: burada içerik SUNUCUDAN gelen METİNDİR → announcements.cjs onu düşman girdi
// gibi normalize eder ve aksiyon URL'ini yalnız https'e daraltır.
//
// Kalıcı durum settings.json'da (renderer localStorage'ı restart'ı atlatmaz —
// random-port origin, ADP-437 dersi):
//   announcementsRead      { [id]: epoch }  → okundu (bir daha şerit YOK)
// Oturumluk (diske YAZILMAZ): şeridin ✕'i = "şimdilik gizle"; app yeniden açılınca
// kritik duyuru GERİ GELİR — okunmadıkça kullanıcıyı kaçırmayalım.
// Çevrimdışı: son başarılı feed <crewpaneHome>/announcements-cache.json'a yazılır
// ve açılışta ondan servis edilir (ağ yokken de duyuru görünür).
// ---------------------------------------------------------------------------
let announceState = {
  checked: false,       // en az bir BAŞARILI çekim oldu mu (ağ hatası bunu true yapmaz)
  fromCache: false,     // gösterilen liste diskteki son kopyadan mı geliyor
  lastCheckedAt: null,
  items: [],            // normalize edilmiş TÜM feed (hedef filtresi görünümde uygulanır)
};
/** Oturumluk gizleme (şeridin ✕'i) — kalıcı DEĞİL, bilinçli. */
const announceHiddenThisSession = new Set();

function announceCachePath() {
  // ADP-703 — GLOBAL duyuru feed'inin çevrimdışı kopyası: kullanıcıya özel değil → cihaz kökü.
  return path.join(instancePaths.instanceHome(), 'announcements-cache.json');
}

/** Son başarılı feed'i diske yaz (çevrimdışı açılış için). Hata sessiz. */
function writeAnnounceCache(items) {
  try {
    fs.mkdirSync(instancePaths.instanceHome(), { recursive: true });
    fs.writeFileSync(announceCachePath(), JSON.stringify({ savedAt: Date.now(), items }), 'utf8');
  } catch { /* best-effort — önbellek yazılamazsa yalnız çevrimdışı zenginlik kaybolur */ }
}

/** Diskteki kopyayı oku; yoksa/bozuksa boş liste (normalize TEKRAR uygulanır). */
function readAnnounceCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(announceCachePath(), 'utf8'));
    return announcements.normalizeFeed(raw && raw.items ? raw.items : raw);
  } catch {
    return [];
  }
}

/**
 * ADP-716 — duyuru dili. CrewPane'in kendi arayüzü TR; duyuru feed'i ise TR+EN
 * taşıyabilir. İşletim sistemi dili EN ise EN metni gösteririz, çeviri yoksa TABAN
 * (TR) metne düşeriz — duyuru hiçbir dilde BOŞ görünmez.
 */
function announceLocale() {
  try {
    return announcements.normalizeLocale(app.getLocale());
  } catch {
    return announcements.BASE_LOCALE;
  }
}

/** Renderer görünümü: hedefe uyanlar + okundu haritası + oturumluk gizleme. */
function announceStateForRenderer() {
  const s = agentSettings.readSettings();
  const read = s.announcementsRead && typeof s.announcementsRead === 'object' ? s.announcementsRead : {};
  const visible = announcements.selectAnnouncements(announceState.items, {
    app: announcements.APP_ID,
    version: app.getVersion(),
    channel: currentUpdateChannel(),
    now: Date.now(),
  });
  const locale = announceLocale();
  return {
    checked: announceState.checked,
    fromCache: announceState.fromCache,
    lastCheckedAt: announceState.lastCheckedAt,
    currentVersion: app.getVersion(),
    locale,
    // Dil BURADA çözülür: renderer'a tek düz metin gider (i18n bloğu UI'a sızmaz).
    items: visible.map((a) => announcements.localize(a, locale)).map((a) => ({
      ...a,
      read: Object.prototype.hasOwnProperty.call(read, a.id),
      hidden: announceHiddenThisSession.has(a.id),
    })),
  };
}

function pushAnnounceState() {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send('announce:state', announceStateForRenderer());
    } catch { /* best-effort */ }
  }
}

/** Feed'i çek. HER hata yolu sessiz; başarısız koşu MEVCUT listeyi kirletmez. */
async function runAnnounceCheck(trigger) {
  const url = process.env.CREWPANE_ANNOUNCE_FEED_URL || announcements.FEED_URL;
  const res = await announcements.fetchFeed({ url });
  if (res.ok) {
    announceState = { checked: true, fromCache: false, lastCheckedAt: Date.now(), items: res.items };
    writeAnnounceCache(res.items);
    logLine(`announce(${trigger}): ${res.items.length} duyuru alındı`);
    pushAnnounceState();
  } else {
    logLine(`announce(${trigger}): sessiz geçildi (${res.reason})`);
  }
  return announceStateForRenderer();
}

let announceChecksScheduled = false;
function scheduleAnnounceChecks() {
  if (announceChecksScheduled) return;
  announceChecksScheduled = true;
  // ÇEVRİMDIŞI ÖNCE: ağ beklemeden diskteki son kopyayı göster (uçakta da duyuru var).
  const cached = readAnnounceCache();
  if (cached.length) {
    announceState = { ...announceState, fromCache: true, items: cached };
    logLine(`announce(cache): ${cached.length} duyuru diskten yüklendi`);
  }
  // Test instance'ında feed dikişi yoksa OTOMATİK çekim YOK (e2e filosu GitHub'a
  // vurmasın — updateCheck ile aynı disiplin).
  if (instancePaths.instanceId() === 'test' && !process.env.CREWPANE_ANNOUNCE_FEED_URL) return;
  setTimeout(() => { runAnnounceCheck('auto').catch(() => {}); }, 3000);
  const timer = setInterval(() => { runAnnounceCheck('auto').catch(() => {}); }, announcements.CHECK_INTERVAL_MS);
  timer.unref?.();
}

// A-10 — UYGULAMA İÇİ "YENİLİKLER" (changelog). announce ile AYNI iskelet (main
// çeker → cache eder → renderer'a servis eder), daha basit içerik: hedefli
// dağıtım/i18n/okundu-defteri YOK — panel yalnız son N kaydı gösterir.
// Çevrimdışı: son başarılı feed <crewpaneHome>/changelog-cache.json'a yazılır ve
// açılışta ondan servis edilir (ADP-703 ile aynı gerekçe: içerik kullanıcıya değil
// ÜRÜNE ait → cihaz kökü, kullanıcı klasörü değil).
// ---------------------------------------------------------------------------
let changelogState = {
  checked: false,     // en az bir BAŞARILI çekim oldu mu (ağ hatası bunu true yapmaz)
  fromCache: false,   // gösterilen liste diskteki son kopyadan mı geliyor
  lastCheckedAt: null,
  recentCount: null,       // site'nin countRecent() değeri — panel kendi sayımını YAPMAZ
  recentWindowDays: null,
  items: [],
};

function changelogCachePath() {
  return path.join(instancePaths.instanceHome(), 'changelog-cache.json');
}

/** Son başarılı feed'i diske yaz (çevrimdışı açılış için). Hata sessiz. */
function writeChangelogCache(state) {
  try {
    fs.mkdirSync(instancePaths.instanceHome(), { recursive: true });
    fs.writeFileSync(changelogCachePath(), JSON.stringify({ savedAt: Date.now(), ...state }), 'utf8');
  } catch { /* best-effort — önbellek yazılamazsa yalnız çevrimdışı zenginlik kaybolur */ }
}

/** Diskteki kopyayı oku; yoksa/bozuksa boş sonuç (normalize TEKRAR uygulanır). */
function readChangelogCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(changelogCachePath(), 'utf8'));
    return changelogFeed.normalizeFeed({ entries: raw.items, recentCount: raw.recentCount, recentWindowDays: raw.recentWindowDays });
  } catch {
    return { items: [], recentCount: null, recentWindowDays: null };
  }
}

function changelogStateForRenderer() {
  return { ...changelogState };
}

function pushChangelogState() {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send('changelog:state', changelogStateForRenderer());
    } catch { /* best-effort */ }
  }
}

/** Feed'i çek. HER hata yolu sessiz; başarısız koşu MEVCUT listeyi kirletmez. */
async function runChangelogCheck(trigger) {
  const url = process.env.CREWPANE_CHANGELOG_FEED_URL || changelogFeed.FEED_URL;
  const res = await changelogFeed.fetchFeed({ url });
  if (res.ok) {
    changelogState = {
      checked: true,
      fromCache: false,
      lastCheckedAt: Date.now(),
      recentCount: res.recentCount,
      recentWindowDays: res.recentWindowDays,
      items: res.items,
    };
    writeChangelogCache(changelogState);
    logLine(`changelog(${trigger}): ${res.items.length} kayıt alındı`);
    pushChangelogState();
  } else {
    logLine(`changelog(${trigger}): sessiz geçildi (${res.reason})`);
  }
  return changelogStateForRenderer();
}

let changelogChecksScheduled = false;
function scheduleChangelogChecks() {
  if (changelogChecksScheduled) return;
  changelogChecksScheduled = true;
  // ÇEVRİMDIŞI ÖNCE: ağ beklemeden diskteki son kopyayı göster.
  const cached = readChangelogCache();
  if (cached.items.length) {
    changelogState = { ...changelogState, fromCache: true, ...cached };
    logLine(`changelog(cache): ${cached.items.length} kayıt diskten yüklendi`);
  }
  // Test instance'ında feed dikişi yoksa OTOMATİK çekim YOK (e2e filosu crewpane.dev'a
  // vurmasın — updateCheck/announce ile aynı disiplin).
  if (instancePaths.instanceId() === 'test' && !process.env.CREWPANE_CHANGELOG_FEED_URL) return;
  setTimeout(() => { runChangelogCheck('auto').catch(() => {}); }, 3000);
  const timer = setInterval(() => { runChangelogCheck('auto').catch(() => {}); }, changelogFeed.CHECK_INTERVAL_MS);
  timer.unref?.();
}

// ADP-900 — HAFIZA İNDEKSİ İLK AÇILIŞTA KENDİLİĞİNDEN KURULUR.
//
// ADP-872 §5.2'nin açık sorusu buydu ve ölçülmüş cevabı şuydu: müşterinin
// kurulumunda indeks HİÇ oluşmuyordu — çünkü tek başlatma yolu Hafıza sekmesindeki
// "indeksle" bağlantısıydı ve kimse ona basmıyordu. İndeks olmayınca ajan spawn'ının
// RAG bloğu da boş kalıyor (`index_not_built`), yani ölçülen jeton tasarrufu hiç
// gerçekleşmiyordu.
//
// ÜÇ KISIT — üçü de bilinçli:
//   • MODEL GEREKTİRMEZ. Bu indeksleme kelime katmanıdır (ADP-900 memoryIndexWorker
//     `lexicalOnly`); onay akışıyla İLGİSİ YOKTUR ve tek bayt indirmez.
//   • DÜŞÜK ÖNCELİKLİ + GECİKMELİ. Açılışın ilk saniyeleri pencere/ofis/pane
//     kurulumuna ait; indeksleme oraya CPU rekabeti sokmaz.
//   • KAPATILABİLİR ve GÖRÜNÜR. `memorySearch.autoIndex=false` → hiç koşmaz; koşarken
//     durumu Hafıza sekmesindeki hapta akar (`auto:true` ile işaretli).
const AUTO_INDEX_DELAY_MS = Number(process.env.CREWPANE_AUTO_INDEX_DELAY_MS || 15000);
let autoIndexScheduled = false;
function scheduleAutoMemoryIndex() {
  if (autoIndexScheduled) return;
  autoIndexScheduled = true;
  const t = setTimeout(() => {
    try {
      if (agentSettings.readSettings().memorySearch?.autoIndex === false) {
        logLine('memoryIndex(auto): kullanıcı kapatmış — atlandı');
        return;
      }
      if (!agentWorkspaceRoot) {
        logLine('memoryIndex(auto): çalışma alanı yok — atlandı');
        return;
      }
      const svc = memoryIndexer();
      if (svc.status().running) return;
      const res = svc.start({ workspaceRoot: agentWorkspaceRoot, auto: true });
      logLine(`memoryIndex(auto): ${res.ok ? `başladı → ${res.dbFile}` : `başlatılamadı (${res.reason})`}`);
    } catch (err) {
      // Hafıza indeksi bir açılışı ASLA bozamaz.
      logLine(`memoryIndex(auto): başlatılamadı: ${err.message}`);
    }
  }, AUTO_INDEX_DELAY_MS);
  t.unref?.();
}

// ADP-307 — açılışta e2e-artık taraması. SALT-OKUNUR: canlı ofis DB'sinden ASLA satır
// silmez (gerçek veriyi otomatik silmek, düzeltmeye çalıştığımız hata sınıfının ta kendisi
// — Bumblebee'nin satırını silen spec vakası). Hedefleri DB'nin kendisi söyler
// (crewpane_e2e_residue RPC'si — bariyerle aynı desenler, kopya yok). Bulursa log'a
// yazar; temizliği insan onaylar. Ağ hatası sessizce yutulur (açılışı bloklamaz).
function scanE2EResidueAtStartup() {
  const env = publicSupabaseEnv();
  const url = env.NEXT_PUBLIC_CREWPANE_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY;
  if (!url || !key) return;
  fetch(`${url}/rest/v1/rpc/crewpane_e2e_residue`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
    .then((r) => (r.ok ? r.json() : []))
    .then((rows) => {
      if (!Array.isArray(rows) || rows.length === 0) return;
      const where = [...new Set(rows.map((r) => r.table_name))].join(', ');
      logLine(
        `⚠️ [adp-307] ${rows.length} e2e test artığı bulundu (${where}) — bir spec bu DB'ye yazmış. ` +
        `Otomatik SİLİNMEDİ. İncele: node e2e/prodResidueGuard.cjs`
      );
    })
    .catch(() => { /* DB kapalı / eski şema — açılışı bloklama */ });
}

// ═══ RESET-03 — KURULUMU SIFIRLA: AÇILIŞ YOLU ═══════════════════════════════
//
// TASARIMIN ÇEKİRDEĞİ (RESET-R1 §2c, Windows dosya kilidi): ÇALIŞAN SÜREÇ HİÇBİR
// KULLANICI DOSYASINI SİLMEZ. İstek geldiğinde main bir işaretçi yazar ve uygulama
// yeniden başlar; silme, YENİ sürecin en başında — kilit alındıktan sonra, ama
// hiçbir modül veri köküne dosya AÇMADAN önce — yapılır. `initLog()` bu dosya
// açan ilk şeydir (main.js:112-116'daki sözleşme), bu yüzden kanca ondan ÖNCE.
//
// Aynı kanca `--reset[=session]` bayrağını da karşılar: o yolda işaretçiye gerek
// yoktur (süreç zaten hiçbir şey açmadı), silme doğrudan koşar.
//
// LOG DİKİŞİ: bu noktada `LOG_PATH` henüz yok — satırlar tampona yazılır ve
// `initLog()`ten hemen sonra `logLine` ile DOSYAYA basılır. Yoksa yıkıcı bir
// işlemin tek kanıtı stdout'ta kalırdı (paketli Windows'ta konsol YOK).
let resetBootNotice = null; // → app:info (RESET-02/05 şeridi bunu okur)

/**
 * `installReset` için ORTAK BAĞLAM. Yollar Electron'un KENDİ köklerinden türer —
 * renderer'dan ya da argv'den GELMEZ (RESET-01 riski §5.2).
 */
function resetContext(log) {
  const deps = {
    log,
    userDataDir: app.getPath('userData'),
    logsDir: app.getPath('logs'),
    updaterCacheDir: pickUpdaterCacheDir(),
  };
  // İşaretçiyi YAZAN ve OKUYAN aynı köke bakmak ZORUNDA. `installReset` kökü
  // kendi kuralıyla çözer (CREWPANE_HOME dikişi yalnız test instance'ında
  // geçerlidir); burada ikinci bir `path.join` yazmak İKİNCİ BİR GERÇEK olurdu
  // ve ayrıştığı gün sıfırlama sessizce hiç uygulanmazdı.
  const instanceHome = installReset._internal.normalizeDeps(deps).instanceHome;
  return { deps, instanceHome };
}

/**
 * AÇILIŞ ÖNCESİ DİL — `applyAppLocale()` bu noktada HENÜZ KOŞMADI ve koşamaz:
 * kullanıcının saklı tercihi ayar dosyasındadır, o dosya veri kökündedir ve tam
 * da silmeye çalıştığımız şeydir (HATA-03'te tek-örnek kilidi aynı sonuca vardı:
 * "ayar dosyasına dokunmak tam da engellemeye çalıştığımız yazma olurdu").
 * Kalan doğru kaynak işletim sisteminin dili.
 */
function resetBootLocale() {
  try {
    const pinned = process.env.CREWPANE_SYSTEM_LOCALE;
    if (typeof pinned === 'string' && pinned.trim()) return appI18n.localeFromSystem(pinned.trim());
    let sys = '';
    try { sys = app.getLocale() || ''; } catch { /* ready öncesi boş dönebilir */ }
    if (!sys) { try { sys = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch { /* ICU yok */ } }
    return appI18n.localeFromSystem(sys);
  } catch { return undefined; } // t() kendi varsayılanına düşer
}

/** Açılış öncesi kutuların metni — dil ayar dosyası OKUNMADAN çözülür. */
function resetT(key) {
  return appI18n.t(key, undefined, resetBootLocale());
}

/**
 * Güncelleyici önbelleği: adaylardan DİSKTE VAR OLANI seç (yoksa ilkini dön —
 * `installReset` onu `missing` sayar, zararsız). Ad `basename(userData)`tir;
 * gerekçe + ölçüm: electron/resetGate.cjs updaterCacheCandidates.
 */
function pickUpdaterCacheDir() {
  const cands = resetGate.updaterCacheCandidates({
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
    userDataDir: app.getPath('userData'),
    appName: app.getName(),
  });
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* erişilemiyor → sıradaki */ }
  }
  return cands[0] || null;
}

/**
 * Bekleyen işaretçiyi UYGULA. Önce yetim yardımcı süreçler biçilir (ADP-727):
 * ölü bir `next-server` veri kökündeki bir dosyayı açık tutuyorsa Windows'ta
 * `fs.rm` EBUSY döner ve sıfırlama yarım kalırdı.
 *
 * `locked` doluysa İŞARETÇİ KALIR — bir sonraki açılış tekrar dener
 * ([[one-shot-skip-postpones-the-lie]]: temizlenmeyen damga yalan söylemez).
 *
 * @returns {Promise<object|null>} `resetGate.bootNotice` çıktısı (yol adı YOK) ya da null
 */
async function applyPendingReset(log) {
  const { deps, instanceHome } = resetContext(log);
  let marker = null;
  try {
    marker = await installReset.readMarker(instanceHome, deps);
  } catch (e) {
    log(`[reset] işaretçi okunamadı (${(e && e.code) || 'ERR'})`);
    return null;
  }
  if (!marker) return null;
  log(`[reset] bekleyen istek uygulanıyor (seviye=${marker.level} yaş=${Math.round(marker.ageMs / 1000)}sn)`);
  try {
    const reap = helperReaper.reapStaleHelpers(instanceHome, { log: (m) => log(`[reset] ${m}`) });
    if (reap && reap.reaped.length) log(`[reset] ${reap.reaped.length} yetim yardımcı biçildi (dosya kilidi)`);
  } catch (e) { log(`[reset] yetim toplama atlandı (${(e && e.code) || 'ERR'})`); }
  let res;
  try {
    res = await installReset.execute({ ...deps, level: marker.level, keepLogs: marker.keepLogs });
  } catch (e) {
    // `execute` sözleşme gereği throw ETMEZ; yine de buraya düşersek işaretçi
    // KALIR (bir sonraki açılış dener) ve kullanıcıya yalan söylenmez.
    log(`[reset] uygulama HATASI (${(e && e.code) || 'ERR'}) — işaretçi korundu`);
    return { kind: 'partial', level: marker.level, bytesFreed: null, removedCount: 0, lockedCount: 1, skippedCount: 0 };
  }
  const notice = resetGate.bootNotice(marker.level, res);
  log(`[reset] sonuç ok=${res.ok ? 1 : 0} silinen=${notice.removedCount} kilitli=${notice.lockedCount} `
    + `atlanan=${notice.skippedCount} süre=${res.durationMs}ms`);
  if (notice.lockedCount) {
    log('[reset] işaretçi KORUNDU — kilitli hedefler bir sonraki açılışta tekrar denenecek');
  } else {
    const cleared = await installReset.clearMarker(instanceHome, deps);
    log(`[reset] işaretçi temizlendi=${cleared.ok ? 1 : 0}`);
  }
  return notice;
}

/**
 * `--reset[=session] [--yes]` — komut satırı yolu.
 *
 * KULLANIM ALANI: uygulama AÇILAMIYORSA (bozuk oturum dosyası, giriş döngüsü)
 * kullanıcının tek kaçışı budur. GUI uygulamada Windows'ta konsol yoktur → her
 * şey native kutuyla konuşur.
 *
 * @returns {Promise<boolean>} true = açılış KESİLMELİ (süreç çıkıyor)
 */
async function runArgvReset(req, log) {
  if (req.invalid !== undefined) {
    // Yazım hatası sessizce TAM sıfırlamaya düşmez (resetGate kapısı).
    log('[reset] komut satırında TANINMAYAN seviye — hiçbir şey silinmedi');
    try {
      dialog.showErrorBox(resetT('main.reset.badLevel.title'), resetT('main.reset.badLevel.detail'));
    } catch { /* kutu çizilemedi → stdout satırı kaldı */ }
    app.exit(2);
    return true;
  }
  if (!req.yes) {
    let picked = 1;
    try {
      picked = dialog.showMessageBoxSync({
        type: 'warning',
        title: resetT('main.reset.confirm.title'),
        message: req.level === 'session'
          ? resetT('main.reset.session.message')
          : resetT('main.reset.confirm.message'),
        detail: resetT('main.reset.confirm.detail'),
        buttons: [resetT('main.reset.confirm.button.yes'), resetT('main.reset.confirm.button.cancel')],
        defaultId: 1, // VARSAYILAN "Vazgeç": Enter'a basan kullanıcı silmez
        cancelId: 1,
        noLink: true,
      });
    } catch (e) {
      // Kutu çizilemiyorsa (başsız/otomasyon) ONAY ALINAMAMIŞTIR → SİLME.
      log(`[reset] onay kutusu gösterilemedi (${e && e.message}) — sıfırlama İPTAL`);
      app.exit(2);
      return true;
    }
    if (picked !== 0) {
      log('[reset] kullanıcı vazgeçti — hiçbir şey silinmedi');
      app.exit(0);
      return true;
    }
  }
  const { deps } = resetContext(log);
  log(`[reset] komut satırından sıfırlama (seviye=${req.level} onay=${req.yes ? 'bayrak' : 'kutu'})`);
  // Telemetri SİLMEDEN ÖNCE: `installId` ayar dosyasında yaşar ve tam sıfırlamada
  // o dosya gider. Sonraya bırakılsaydı olay ya kimliksiz kalır ya da YENİ bir
  // kurulum gibi görünürdü.
  let planned = null;
  try { planned = await installReset.plan({ ...deps, level: req.level }); } catch { /* kova 'unknown' olur */ }
  sendResetTelemetry({ level: req.level, source: 'cli', bytes: planned && planned.bytesTotal });
  const res = await installReset.execute({ ...deps, level: req.level });
  const notice = resetGate.bootNotice(req.level, res);
  log(`[reset] cli sonuç ok=${res.ok ? 1 : 0} silinen=${notice.removedCount} kilitli=${notice.lockedCount}`);
  if (notice.lockedCount) {
    try {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: resetT('main.reset.partial.title'),
        message: resetT('main.reset.partial.message'),
        detail: resetT('main.reset.partial.detail'),
        buttons: [resetT('main.reset.partial.button.ok')],
        noLink: true,
      });
    } catch { /* best-effort */ }
  }
  resetBootNotice = notice;
  return false; // açılış NORMAL devam eder (temiz kuruluma düşer)
}

/**
 * Tek anonim olay — ham bayt/yol GÖNDERİLMEZ (yalnız kova). Kapalıysa hiç gitmez.
 * Yük SİLMEDEN ÖNCE bilinenlerle sınırlıdır: "silme başarılı mıydı" o anda
 * ölçülemez, bu yüzden TAHMİN EDİLMEZ (analyticsSchema.install_reset başlığı).
 */
function sendResetTelemetry(o) {
  try {
    analyticsNow().track('install_reset', {
      level: o.level,
      source: o.source,
      bytes_planned_bucket: resetGate.bytesBucket(o.bytes),
    });
    // Yeniden başlatma HEMEN geliyor: tampon boşaltılmazsa olay süreçle birlikte ölür.
    analyticsNow().flush('install_reset');
  } catch { /* telemetri ASLA çağıranı düşürmez */ }
}

app.whenReady().then(async () => {
  // RESET-03 — KOMUT SATIRI YOLU, KİLİT KAPISI. `--reset` istendiyse ve kilit
  // BİZDE DEĞİLSE (uygulama başka bir kopyada açık) hiçbir şeye dokunmadan
  // çıkılır: açık uygulamanın altından veri kökünü silmek, tam da tasarımın
  // engellediği durumdur. Çıkış kodu 2 — destek betikleri "kapalı değildi"yi
  // "sıfırlandı"dan ayırt edebilsin.
  const resetCli = resetGate.argvReset(process.argv);
  const lockIsOurs = !singleInstanceGate
    || singleInstanceGate.enforced === false // CREWPANE_SINGLE_INSTANCE=0 (kaçış kapağı)
    || singleInstanceGate.primary === true;
  if (resetCli && !lockIsOurs) {
    try { process.stderr.write('[reset] kilit BİZDE DEĞİL — uygulama açık, sıfırlama yapılmadı\n'); } catch { /* ignore */ }
    try {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: resetT('main.reset.locked.title'),
        message: resetT('main.reset.locked.message'),
        detail: resetT('main.reset.locked.detail'),
        buttons: [resetT('main.reset.partial.button.ok')],
        noLink: true,
      });
    } catch { /* kutu çizilemedi → stderr satırı kaldı */ }
    app.exit(2);
    return;
  }
  // ENV-08-FIX-01 — İKİNCİ KOPYA BARİYERİ. Kilit kapısı ikinci kopyanın diyaloğunu
  // bu kancadan ÖNCE (kendi whenReady'sinde) açar ve kararı burada BEKLETİRİZ.
  // İki ölçülmüş gerekçe: (1) `app.exit()` ASENKRONDUR (aşağıdaki ENV-01 kapısında
  // da aynı gerekçe) — "Kapat"tan sonra bu kanca yine koşuyordu ve ölmekte olan
  // kopya hesabı bağlayıp standalone sunucuyu + Next'i başlatıyordu, yani tam da
  // engellemeye çalıştığımız İKİNCİ YAZAR oluyordu; (2) diyalog artık ASENKRON
  // (kutu açıldıktan sonra pencereyi öne alabilmek için) → senkron modal'ın açılışı
  // bloklama yan etkisi yok, beklemeyi AÇIKÇA yapıyoruz. "Yine de aç" seçilirse söz
  // `false` çözülür ve açılış kaldığı yerden sürer.
  if (singleInstanceGate && typeof singleInstanceGate.whenDecided === 'function'
    && await singleInstanceGate.whenDecided()) return;
  // RESET-03 — SİLME BURADA, `initLog()`TEN ÖNCE. Bu satırdan sonrası veri
  // köküne dosya AÇAR (log dosyası, çökme defteri, ayarlar, pane defteri);
  // Windows'ta açık bir tutamaç `fs.rm`i EBUSY ile düşürür. Satırlar tampona
  // yazılır ve log açılır açılmaz dosyaya basılır (kanıt stdout'ta kalmasın).
  {
    const resetLines = [];
    const resetLog = (m) => {
      resetLines.push(String(m));
      try { process.stderr.write(`${m}\n`); } catch { /* ignore */ }
    };
    try {
      if (resetCli && await runArgvReset(resetCli, resetLog)) return; // süreç çıkıyor
      if (!resetCli) resetBootNotice = await applyPendingReset(resetLog);
    } catch (e) {
      resetLog(`[reset] açılış kancası HATASI (${(e && e.code) || 'ERR'}) — açılış normal sürüyor`);
    }
    initLog();
    for (const line of resetLines) logLine(line);
    // WIN-DUP-INSTANCE-01 — kilit kararı artık DOSYA log'unda (destek kanıtı).
    for (const line of singleInstanceEarlyLog.splice(0)) logLine(`[single-instance] ${line}`);
    if (singleInstanceGate) {
      logLine(`[single-instance] sonuç: primary=${!!singleInstanceGate.primary}`
        + ` forced=${!!singleInstanceGate.forced} degraded=${!!singleInstanceGate.degraded}`
        + `${singleInstanceGate.why ? ` why=${singleInstanceGate.why}` : ''}`
        + `${singleInstanceGate.reason ? ` reason=${singleInstanceGate.reason}` : ''}`);
    }
    // YARIM SIFIRLAMA SESSİZ KALAMAZ. `locked` doluysa işaretçi duruyor demektir
    // ve kullanıcının yapması gereken tek şey var: kapat, tekrar aç. Bunu söyleyen
    // yüzeyi MAIN çizer — uygulama-içi şerit (RESET-02) henüz açılmamış bile
    // olabilir ve sessiz bir boş ekran YALAN olurdu ([[silent-empty-state-is-a-lie]]).
    if (!resetCli && resetBootNotice && resetBootNotice.kind === 'partial') {
      try {
        dialog.showMessageBox({
          type: 'warning',
          title: resetT('main.reset.partial.title'),
          message: resetT('main.reset.partial.message'),
          detail: resetT('main.reset.partial.detail'),
          buttons: [resetT('main.reset.partial.button.ok')],
          noLink: true,
        }).catch(() => { /* kutu gösterilemedi — log satırı kanıt olarak kaldı */ });
      } catch (e) { logLine(`[reset] uyarı kutusu gösterilemedi: ${e && e.message}`); }
    }
  }
  // ENV-01 — AÇILIŞ BANNER'I + KARIŞIM KAPISI. `initLog()`ten hemen SONRA: satır dosya
  // log'una da düşsün (GUI'den açılan kopyada terminal yok). Pencere/Next/mobil/
  // e2e-artık taramasından ÖNCE: karışım varsa TEK BİR istek bile çıkmadan durulur
  // (`scanE2EResidueAtStartup` bu satırdan sonra fetch atıyor — sıra bu yüzden kritik).
  // `app.exit(1)` çağrıldı ama Electron çıkışı asenkron: `return` ile açılışın kalanını
  // da kesiyoruz ki ölmekte olan süreç bu arada bir yere BAĞLANMASIN.
  if (logEnvBannerAndGuard().level === 'block') return;
  // CRASH-R1 — ÖNCEKİ KAPANIŞI RAPORLA. "Uygulama kendiliğinden kapandı" şikâyeti
  // 13/14/16.09'da üç kez geldi ve her seferinde sebep günlük arkeolojisiyle
  // aranmak zorunda kaldı. Artık ilk satırlarda yazıyor. KAYIT YOKSA da bir şey
  // söyler: temiz kapanışta satır HEP yazılır → yokluğu SIGKILL (jetsam / Force
  // Quit / panic) demektir.
  try {
    // `app.isPackaged` şartı: paketsiz koşuda LOG_PATH zaten spike-log.txt'dir,
    // "yalıtıldı" demek YANILTICI olurdu (yalıtılacak ortak dosya orada yok).
    if (app.isPackaged && LOG_TARGET && LOG_TARGET.isolated) {
      logLine(`[crash-r1] YALITILMIŞ GÜNLÜK (${LOG_TARGET.source}) → ${LOG_PATH} — canlı uygulamanın günlüğüne DOKUNULMADI`);
    }
    logLine(`[crash-r1] ${crashJournal.formatPrevious(crashJournal.readLast(instancePaths.instanceHome(crewpaneHome())))}`);
    crashJournal.trim(instancePaths.instanceHome(crewpaneHome()));
  } catch (e) { logLine(`[crash-r1] kapanış defteri okunamadı: ${e.message}`); }
  // ADP-888 (ADP-885 Faz A) — DİLİ RENDERER'DAN ÖNCE ÇÖZ. Main, pencere hiç
  // açılmadan da diyalog gösterebilir (çökme bildirimi, lisans hatası); o metin
  // renderer'ın diline BAĞLANAMAZ. Tercih 'system' ise işletim sistemi sorulur
  // (app.getLocale() yalnız whenReady'den sonra doğrudur).
  applyAppLocale();
  // ENV-08 (d) — GEÇİCİ KONUM UYARISI (28.08: DMG doğrudan açıldı → AppTranslocation
  // kopyası prod çözüp gerçek veri köküne bağlandı). Tek-örnek kilidi (yukarıdaki
  // enforce) çarpışmayı zaten engeller; bu kutu kullanıcıya NEDENİNİ söyler ve temiz
  // çıkışlar sunar. BLOKLAMAZ (fail-open bilgi kutusu): "Anladım" → açılış normal
  // sürer; "Ayrı test profiliyle yeniden başlat" → kilit bırakılır + --instance=test.
  try {
    if (require('./src/core/translocationNotice.cjs').isTransientLocation(process.execPath, process.platform)) {
      logLine(`[env-08] geçici konumdan koşuyor (AppTranslocation/DMG): ${process.execPath}`);
      const i18nMod = require('./i18n/index.cjs');
      dialog.showMessageBox({
        type: 'warning',
        title: i18nMod.t('main.translocation.title'),
        message: i18nMod.t('main.translocation.message'),
        detail: i18nMod.t('main.translocation.detail'),
        buttons: [i18nMod.t('main.translocation.button.ok'), i18nMod.t('main.translocation.button.separateProfile')],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }).then(({ response }) => {
        if (response !== 1) return;
        logLine('[env-08] kullanıcı geçici konumdan AYRI TEST PROFİLİYLE yeniden başlatmayı seçti');
        try {
          singleInstanceLock.releaseForRelaunch({
            dataRoot: instancePaths.instanceHome(),
            log: (m) => logLine(`[env-08] ${m}`),
          });
        } catch (e) { logLine(`[env-08] kilit bırakılamadı: ${e && e.message}`); }
        const args = process.argv.slice(1)
          .filter((a) => !/^--(crewpane-)?instance=/.test(a))
          .concat(['--instance=test']);
        try { app.relaunch({ args }); } catch (e) { logLine(`[env-08] relaunch hatası: ${e && e.message}`); }
        app.exit(0);
      }).catch((e) => logLine(`[env-08] translocation kutusu gösterilemedi: ${e && e.message}`));
    }
  } catch (e) { logLine(`[env-08] translocation tespiti atlandı: ${e && e.message}`); }
  // ADP-734 Kapı 2 — defter küçülme nöbeti: yedek zaten kayıt modülünde alınır;
  // burada LOG'a basılır ve defter BOŞALIYORSA kullanıcıya teklif edilir. Sessiz
  // bir "7 pane → 0" yazımı bir daha yaşanmasın.
  // ENG-05 — defterlere bilinmeyen bir motor yazılmaya çalışıldığında (yazım hatası,
  // bozuk kayıt, HENÜZ tanınmayan yeni motor) satır `crewpane-shell.log`'a düşsün.
  // Saf modül log bilmez; gözlemci dikişi burada takılır.
  engineCoerce.setUnknownEngineObserver((info) => {
    logLine(`ENG-05 ${info.message}`);
  });
  livePaneRegistry.setShrinkObserver((info) => {
    logLine(
      `live-panes KÜÇÜLDÜ ${info.prev}→${info.next} (sebep=${info.reason}) yedek=${info.backup ?? '-'}`,
    );
    if (info.next === 0 && info.reason !== 'consume') {
      try {
        const entries = Object.entries(info.panes || {}).map(([paneId, e]) => ({ paneId, ...e }));
        offerRecoverablePanes(appWindow, entries, {
          reason: `registry-emptied:${info.reason}`,
          backup: info.backup,
        });
      } catch { /* teklif best-effort */ }
    }
  });
  startCrashWatchdog(); // ADP-475 — running from boot so a heavy-build death has ticks leading into it
  // ADP-475 — app-LEVEL catch-all (covers GPU/utility processes too, not just the
  // app window's renderer). Logged unconditionally, in ADDITION to the per-window
  // render-process-gone handler below (which also drives the reload recovery) —
  // this one never reloads anything itself, it's pure redundant evidence.
  app.on('child-process-gone', (_e, details) => {
    logLine(`CHILD PROCESS GONE: ${JSON.stringify(details)}`);
  });
  scanE2EResidueAtStartup();
  // MCP-COST-01 — ACILIS SUPURMESI. Onceki oturum cokerek olduyse (CRASH-0243-03
  // gecesi gibi) motorlarin MCP cocuklari geride kalmis olabilir: sahibi yok, is
  // yapmiyor, bellek tutuyor. Yalniz ATA ZINCIRINDE CANLI MOTOR OLMAYAN ve
  // 60 sn'den yasli surecler biçilir — yeni restore edilen bir pane'in MCP'si
  // yas kapisina takilir. `ps` okunamazsa hicbir sey iddia edilmez, hicbir sey
  // olmez. Acilisi BEKLETMEZ (fire-and-forget).
  setTimeout(() => {
    mcpProcess.reapOrphanMcp().then((res) => {
      if (res && res.reaped.length) {
        logLine(`mcp-sweep(boot) reaped=${res.reaped.length}/${res.scanned} `
          + `pids=${res.reaped.map((r) => r.pid).join(',')}`);
      }
    }).catch((e) => logLine(`mcp-sweep(boot) failed: ${(e && e.message) || e}`));
  }, 5000).unref?.();
  // ADP-727 (katman A) — AÇILIŞTA YETİM TOPLA. Önceki oturum SIGKILL ile öldüyse
  // (jetsam / Force Quit / çökme) `before-quit` koşmamıştır ve gömülü Next sunucusu
  // PPID=1 olarak yaşamaya devam eder. Defterdeki her kaydı ÜÇLÜ kimlik kapısından
  // geçirip (pid yaşıyor + ps başlangıç zamanı aynı + komut imzası tutuyor) öldürür;
  // biri bile tutmazsa dokunmaz (8 gün sonra pid yeniden kullanılmış olabilir).
  try {
    const reap = helperReaper.reapStaleHelpers(crewpaneHome(), { log: logLine });
    if (reap.reaped.length) logLine(`startup reap: ${reap.reaped.length} orphan helper(s) killed (${reap.reaped.map((r) => `${r.kind}:${r.pid}`).join(', ')})`);
    else if (reap.checked) logLine(`startup reap: ${reap.checked} ledger entr(ies) checked, none stale`);
    // ADP-727 — DEFTERSİZ YETİMLER. Defter yalnız BU sürümden sonrasını kapsar;
    // Eren'in makinesinde kayıt öncesinden kalma 11 yetim vardı (en eskisi 8 gün
    // 18 saat) ve hiçbiri defterde değildi. Süpürge onları PPID=1 + imza +
    // ÇALIŞMA DİZİNİ ile bulur — cwd şart: Next süreç başlığını değiştirdiği için
    // komut satırında yol kalmıyor ve aynı makinede BAŞKA projelerin (crewpane-com)
    // next-server'ları da PPID=1 duruyor.
    // ADP-835 (790 P3): win32'de İKİ ADIM DA farklı — reparenting olmadığı için
    // yetimlik "ebeveyn canlı listede yok" ile ölçülür, kimlik ise cwd yerine
    // CommandLine'dan kurulur (Win32_Process'te cwd alanı yok). Bkz.
    // electron/platform/procProbe.cjs + helperReaper.sweepUnledgeredOrphans.
    const sweep = helperReaper.sweepUnledgeredOrphans(
      [REPO_ROOT, standaloneDir(), app.isPackaged ? process.resourcesPath : null],
      { log: logLine },
    );
    if (sweep.reaped.length) logLine(`startup sweep: ${sweep.reaped.length} unledgered orphan(s) killed (${sweep.reaped.map((r) => r.pid).join(', ')})`);
  } catch (e) { logLine(`startup reap failed: ${e.message}`); }
  ensureSpawnHelperExecutable();
  rehydrateGrantedRoots(); // ADP-109 — re-grant folders the user opened before (restore)

  // ADP-390 — `crewpane://` şemasını bu app'e kaydet + hesabı depodan yükle.
  // Paketsiz (dev) Electron'da OS yönlendirmesi güvenilmez (`open scheme://` = -600,
  // ADP-382 kanıtı) — dev'de callback e2e dikişinden (crewpane:handleUrl) gelir;
  // gerçek yönlendirme kanıtı PAKETLİ app'e aittir (build.protocols → CFBundleURLTypes).
  //
  // ADP-719 — DEV KAYDI KALDIRILDI (ölçülmüş zarar): buradaki `else` dalı
  // `process.execPath` ile kaydediyordu; paketsiz koşuda bu ÇIPLAK Electron
  // ikilisidir ve LaunchServices'e `com.github.Electron` default handler olarak
  // yazılıyordu. Ölçüm (com.apple.launchservices.secure.plist):
  //     LSHandlerURLScheme "crewpane" → LSHandlerRoleAll "com.github.electron"
  // Yani KURULU CrewPane yerine bir Electron ikilisi giriş dönüşünü alıyordu
  // ve dev süreci ölünce kayıt silinmiyordu. Artık dev'de talep edilmez;
  // sahiplik alındı mı diye ayrıca DOĞRULANIR (claim ≠ sahiplik).
  schemeOwnership.claimAndVerify({
    // ADP-780-B — kanal başına AYRI şema: dev DMG artık `crewpane-dev`i talep eder,
    // prod'un `crewpane`ini ÇALMAZ. Ölçülen bug (ADP-764 §1.2) tam olarak buydu.
    app, scheme: APP_URL_SCHEME, log: logLine,
    allowDevClaimEnv: 'CREWPANE_ALLOW_DEV_PROTOCOL_CLAIM',
    // ADP-801 — e2e/ajan koşusu insan kanalının şemasını SAHİPLENMEZ.
    automated: IS_AUTOMATED_SESSION,
    automatedReason: AUTOMATED_SESSION_REASON,
    // LX-SCHEME-01 — Linux'ta bu çağrı `.desktop` kaydını da KURAR (idempotent).
    // Açılışı BEKLETMEZ: `.then` ile bağlı, `await` edilmiyor.
    platform: process.platform,
  }).then((v) => { schemeVerdict = v; })
    .catch((e) => logLine(`scheme ownership check error: ${e && e.message}`));
  // ADP-592 — keychain kapsamı değiştiyse (ilk 0.2.14 açılışı) eski blob'lar artık
  // ÇÖZÜLEMEZ. Silmiyoruz: `.bak`'a alıp markörü yazıyoruz, böylece "neden çıkış
  // yaptım?" sorusu logda cevaplı ve dosya geri dönülebilir. İdempotent.
  try {
    logLine(`safeStorage keychain kapsamı: "${safeStorageIdentity.keychainServiceName(SAFE_STORAGE_SCOPE)}"`);
    // LX-SCHEME-01 (HATA-11 D6) — SIR SAKLAMA GERÇEĞİ. Eskiden yalnız yukarıdaki
    // kapsam adı loglanıyordu; seçilen arka uç ve kullanılabilirlik HİÇ yazılmıyordu.
    // Linux'ta `basic_text`e düşen bir müşteride oturum saklanamaz (credentialVault
    // düz metni reddeder) ve bugün bu HİÇBİR LOGDA görünmüyordu.
    // LX-SAFESTORAGE-01 — ölçüm ARTIK TEK BOĞAZDAN geçiyor: hüküm bir kez alınır,
    // bellekte tutulur ve üç yüzey (seatGate yazma kapısı · giriş duvarı uyarısı ·
    // Ayarlar→Sistem Durumu satırı) AYNI nesneyi okur. Log satırı DEĞİŞMEDİ.
    secretBackendState.initSecretBackendState({
      safeStorage: require('electron').safeStorage,
      platform: process.platform,
      log: logLine,
    });
    safeStorageIdentity.migrateAuthBlobs({
      homeDir: instancePaths.instanceHome(), // ADP-703 — auth/ cihaz kökünde (seatGate ile aynı)
      scope: SAFE_STORAGE_SCOPE,
      log: (line) => logLine(line),
    });
  } catch (e) { logLine(`keychain scope migration error: ${e.message}`); }
  initSeatGate();
  // ADP-703 — HESAP KÖKÜNÜ BAĞLA. Pencereden, bridge'den, pane restore'dan ve her
  // veri modülünden ÖNCE: `CREWPANE_ACCOUNT` pin'i buradan sonra spawn edilen HER
  // çocuğa miras geçer (ADP-206'nın CREWPANE_INSTANCE deseni). Bekleme yalnız disk
  // okumasıdır (seatGate.init ağa çıkmaz), yani açılış gecikmesi ölçülebilir değil.
  await bindAccountRoot('boot').catch((e) => logLine(`[account] bağlama hatası: ${e.message}`));
  // ADP-852 v3 — P0: hesap pin'i YENİ yazıldı, ayar önbelleği YENİ düştü. Modül
  // yüklenirken (pin'den ÖNCE) çözülmüş `agentWorkspaceRoot` bu ana kadar YANLIŞ
  // dosyadan geliyordu; pencereler açılmadan ÖNCE burada düzeltilir.
  try { reresolveWorkspaceRootAfterAccountBind(); }
  catch (e) { logLine(`workspace: yeniden çözme hatası: ${e.message}`); }
  // SYNC-F1-6 — senkron motorunu ŞİMDİ çöz: kökler bu satırdan ÖNCE kesinleşmez
  // (hesap pin'i + workspace yeniden çözümü). Tercih KAPALIYSA hiçbir şey kurulmaz.
  try {
    const st = syncRuntime.refresh({ tickNow: true });
    logLine(`[sync] açılış: ${st.enabled ? `AÇIK (workspace=${st.setup.workspaceKey})` : `kapalı (${st.setup.reason})`}`);
  } catch (e) { logLine(`[sync] açılış bağlaması hatası: ${e.message}`); }
  // SYNC-F1-7 — AÇILIŞTA İKİ YÖN:
  //   1. `prefsApplySoon()` — geçen oturumda İNMİŞ ama uygulanmamış bir doküman
  //      olabilir (uygulama anı ile kapanış çakışmışsa). Uygulama idempotenttir.
  //   2. `prefsProjectNow('boot')` — bu cihazın ayarları henüz hiç yansımadıysa
  //      (ilk açılış, ya da özellik yeni geldi) projeksiyon ŞİMDİ doğar; aksi
  //      hâlde ilk taşıma bir sonraki ayar değişikliğine kadar beklerdi.
  // Sıra ÖNEMLİ: önce uygula (uzak taze değer kazansın), sonra yansıt.
  try { prefsApplySoon(); prefsProjectNow('boot'); }
  catch (e) { logLine(`[prefs] açılış bağlaması hatası: ${e.message}`); }
  // SKL-B6 — GÖMÜLÜ KATALOĞU KUR, SONRA eşitle. Sıra önemlidir: tohumlama kanonik
  // depoya yazar, `syncSkillEngineViews` o depoyu motor dizinlerine bağlar. Ters
  // sırada yeni kurulan skill bir sonraki açılışa kadar hiçbir motorda GÖRÜNMEZDİ.
  seedBuiltinSkills('boot');
  // SKL-B0 — kök artık KESİN: motor skill dizinlerini burada eşitle. Yayın fiilini
  // beklemek, defter büyüdüğünde eklenen motorların dizinini hiç kurmuyordu.
  syncSkillEngineViews('boot');
  // ADP-833 (ADR-W6) — SOĞUK AÇILIŞ: OS uygulamayı DEEP-LINK İÇİN açtıysa URL
  // `process.argv`dedir (Windows'ta `open-url` gibi bir olay YOKTUR). darwin
  // BİLEREK dışarıda: orada dönüş her zaman `open-url` ile gelir ve argv'yi ayrıca
  // okumak bugünkü macOS davranışını değiştirme riski taşır (bit-bit korunuyor).
  if (process.platform !== 'darwin') consumeArgvDeepLink(process.argv, 'cold-start-argv');
  drainPendingAuthUrls();

  wireIpc();
  // PANE-CAP-01 — kaynak bekçisi örneklemesi. `wireIpc()`ten SONRA: ilk ölçüm
  // `onChange` ile renderer'a kart itebilir ve o kanalın ucu burada kurulur.
  // Zamanlayıcı `unref`li — açılışı da çıkışı da geciktirmez.
  try {
    startResourceGovernorSampling();
  } catch (err) {
    // Bekçi bir KOLAYLIKTIR; ölçemezsek uygulama sınırsız çalışır (fail-open).
    logLine(`resourceGovernor başlatılamadı: ${err.message} — bekçisiz devam`);
  }

  // (ADP-440 — adshot:// frozen-frame protokolü overlay ile birlikte kaldırıldı.)

  if (MODE === 'spike') {
    createSpikeWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createSpikeWindow();
    });
    if (AUTOTEST) {
      setTimeout(() => {
        logLine('autotest watchdog timeout — quitting');
        noteQuit('watchdog', 'autotest-timeout');
        app.quit();
      }, 20000);
    }
    return;
  }

  // PROV-01 — Groq'un /responses ucu codex 0.147'nin gövdesini reddediyor (providers.cjs
  // başındaki ölçüme bakın). Sanitize eden yerel geçişi burada başlatıyoruz; portu
  // ANCAK dinlemeye başladıktan sonra env'e yazıyoruz, çünkü providers.effectiveBaseUrl
  // o env'in varlığına bakarak yönlendirme yapıyor. Başlatma düşerse env yazılmaz ⇒
  // istekler doğrudan Groq'a gider (bugünkü davranış) — sessiz kırılma yok, yalnız log.
  groqShim.startGroqShim({ log: logLine }).then(({ port }) => {
    process.env.CREWPANE_GROQ_SHIM_PORT = String(port);
    logLine(`[groq-shim] 127.0.0.1:${port} — Groq istekleri buradan temizlenerek geçecek`);
  }).catch((err) => {
    logLine(`[groq-shim] başlatılamadı (${err.message}) → Groq'a DOĞRUDAN gidilecek`);
  });

  // ADP-594 — start Responses→ChatCompletions adapter if needsShim:true providers exist
  if (providers.allProviders().some(p => p.needsShim)) {
    adapter.startAdapter().then(({ port }) => {
      logLine(`[adapter] started on 127.0.0.1:${port}`);
    }).catch((err) => {
      logLine(`[adapter] start failed: ${err.message}`);
    });
  }

  // ADP-121 (ADR-009) — Jarvis activation hotkey (toggle).
  registerJarvisShortcut();
  // HAND-A2 — açılış ısınması: gizli tespit penceresi kamerasız yüklenir,
  // GPU shader'ları boş kanvasla derlenir (kamera ışığı YANMAZ).
  scheduleHandControlWarmup();
  app.on('before-quit', () => {
    // Kapanışta kaynak kalmaz: kamera kapanır, basılı buton bırakılır; gizli
    // pencere app ile ölür (kalıcı süreç YOK — D mimarisinin varlık nedeni).
    try { stopHandControl('uygulama kapanıyor'); } catch { /* kapanış yarışı zararsız */ }
  });
  // ADP-533 — açılış + ~6 saat periyodik güncelleme kontrolü (sessiz-hata sözleşmesi).
  scheduleUpdateChecks();
  // ADP-715/845 — TELEMETRİ. Sırayla: (1) hata takibi kablosu — ADP-845 K1 gereği
  // SDK/DSN yok, yani bugün `enabled:false` döner ve TEK OLAY GİTMEZ; kablonun
  // doğru dosyada olması yarın DSN verildiğinde tek satırla açılabilmesi içindir.
  // (2) heartbeat — bugün gerçekten veri üreten kısım.
  try {
    const t = telemetryMod.initTelemetry({
      version: app.getVersion(),
      config: agentSettings.readSettings(),
      // INT-OBS-01 — Entegrasyon Merkezi'nden kurulan anahtarlar da buradan görünür.
      deps: { provisionStore: telemetryProvisioning().store },
    });
    logLine(`telemetry: hata-takibi ${t.enabled ? `AÇIK (${t.channel})` : `kapalı (${t.reason})`}`);
  } catch (e) {
    logLine(`telemetry: init atlandı (${e && e.message})`);
  }
  // OBS-02 — hata takibi (Sentry) durumunu AÇIKÇA logla. "Kapalı" kelimesi de bir
  // bilgidir: destek "log'da telemetry satırı ne diyor?" diye sorabilsin.
  try {
    const r = obsReporterNow();
    logLine(`obs: sentry ${r.enabledNow() ? 'AÇIK' : 'kapalı'} (kanal=${telemetryChannelMod.resolveChannel()}, sürüm=${app.getVersion()}, ${process.platform}/${process.arch})`);
  } catch { /* raporlayıcı zaten kendi içinde güvenli */ }

  // ─── OBS-01 — ANALİTİK: durum satırı + huninin İLK ADIMI ──────────────────
  // Durum satırı Sentry'ninkiyle aynı sebeple var: destek "log'da analytics satırı
  // ne diyor?" diye sorabilsin. `app_opened` huninin girişidir — `first_run` bu
  // kurulumun ilk açılışını işaretler, yani "kaç kişi kurdu → kaç kişi ilk ajanını
  // çalıştırdı" sorusunun paydası.
  try {
    const a = analyticsNow();
    logLine(`analytics: posthog ${a.enabledNow() ? 'AÇIK' : 'kapalı'} (kanal=${telemetryChannelMod.resolveChannel()}, sürüm=${app.getVersion()})`);
    a.track('app_opened', { first_run: analyticsFirstTime('app_opened') });
  } catch { /* analitik zaten kendi içinde güvenli */ }

  // ─── SEC-W1-C1 — KURCALAMA SİNYALİ ────────────────────────────────────────
  // Ölçüm `tamperSignals.detect()`te (saf, DI'lı, birim testli); burada yalnız
  // MUSLUKLARA bağlanır: PostHog'a bir `tamper` olayı, Sentry'ye `tamper=true`
  // etiketli bir kayıt. İkisi ayrı sorulara cevap verir — "kaç kopya" (analitik)
  // ve "bu çökme kurcalanmış bir kopyadan mı" (hata takibi).
  //
  // Sinyal YOKSA tek satır bile koşmaz: sağlam müşteri paketinde, dev/test
  // DMG'sinde ve bare-run'da `detect()` null döner (bkz. modül başlığındaki
  // yanlış-pozitif tablosu).
  //
  // 🔴 BURAYA BİR "SELFTEST" ENV BAYRAĞI EKLENMEZ. SEC-W1-A1 müşteri paketinden
  // env okuyan kaçış dallarını FİZİKSEL olarak söktü; ölçüm kolaylığı için bir
  // gün sonra yenisini koymak o kararı geri alırdı. Kapının KIRMIZI verebildiği
  // başka türlü ölçülüyor: birim testte dört kol + paketin GERÇEK dosyalarıyla
  // süreç seviyesinde kırmızı/yeşil kolları (SEC-W1-C1 raporu §2.2).
  try {
    const finding = tamperSignals.detect();
    if (finding) {
      logLine(`tamper: TUTARSIZLIK — ${finding.reason} (imza=${finding.signature})`);
      try { analyticsNow().track('tamper', finding); } catch { /* analitik hata üretmez */ }
      try {
        obsReporterNow().capture({
          surface: 'main',
          module: 'tamper',
          label: finding.reason,
          message: `paket bütünlüğü tutarsız: ${finding.reason}`,
          level: 'warning',
          tamper: true,
        });
      } catch { /* hata takibi hata üretmez */ }
    }
  } catch (e) { logLine(`tamper: ölçüm atlandı (${e && e.message})`); }
  // Tampon çıkışta boşalsın: son oturumun olayları bir sonraki açılışı beklemesin.
  // (Tampon diskte DEĞİL bellektedir — çıkışta gönderilmezse kaybolur.)
  app.on('before-quit', () => { try { analyticsNow().flush('quit'); } catch { /* çıkışı geciktirme */ } });

  // ── TEST-ONLY: SENTETİK HATA ENJEKSİYONU ─────────────────────────────────
  // `CREWPANE_FAULT_INJECT` ADP-335'te TANIMLANMIŞ ama HİÇ TÜKETİLMEMİŞTİ
  // (ölçüldü: dosyada tek referans kendi tanımıydı) — yani hata sınırının gerçek
  // uygulamada tuttuğunu kanıtlayacak kanca ölü doğmuştu. OBS-02 onu çalıştırır:
  // `obs` bileti, GERÇEK bir supervisor'ın içinde GERÇEK bir ReferenceError
  // fırlatır → moduleGuard → reportModuleFault → log + bildirim + Sentry. Env
  // verilmediğinde tek satır bile koşmaz (üretimde sıfır etki).
  if (FAULT_INJECT.includes('obs')) {
    logLine('obs: FAULT_INJECT=obs — main yüzeyinde sentetik hata fırlatılıyor');
    supervisorFor('obs-selftest').run('inject', () => {
      // Bilerek tanımsız çağrı: ajanın yazdığı sıradan bir kod hatasının aynısı.
      return globalThis.__obs_bu_fonksiyon_yok__();
    }, null);
  }
  startHeartbeat();
  // ADP-675 — açılış + ~4 saat periyodik DUYURU çekimi (önce diskteki kopya, sonra ağ).
  scheduleAnnounceChecks();
  // A-10 — açılış + ~6 saat periyodik CHANGELOG çekimi (önce diskteki kopya, sonra ağ).
  scheduleChangelogChecks();
  // ADP-900 — hafıza arama indeksini arka planda, düşük öncelikle, gecikmeli kur.
  scheduleAutoMemoryIndex();
  // TTS-ORPHAN-01 · katman D — AÇILIŞTA YETİM `say` SÜPÜRGESİ. Önceki oturum
  // SIGKILL/Force Quit ile gittiyse hiçbir kanca koşmamıştır; ppid 1'e düşmüş,
  // BİZİM tmp yolumuza yazan `say` süreçleri sahipsizdir. Gerekçe ve üç koşullu
  // kapı: electron/jarvisVoice.js · sweepOrphanSayProcesses.
  try {
    const swept = jarvisVoice.sweepOrphanSayProcesses();
    if (swept.killed.length) logLine(`tts: ${swept.killed.length} yetim \`say\` süreci temizlendi (${swept.killed.join(', ')})`);
    // WIN-TTS-SWEEP-01 — "atlandı" ARIZA DEĞİLDİR. Windows/Linux'ta avlanan iki
    // ikili de (say/afplay) yok, dolayısıyla yetim de yok; `ps` hiç çağrılmaz.
    // Eskiden bu durum her açılışta "koşamadı — ps-failed: …ENOENT" diye
    // yazılıyor ve gerçek arızaları gürültüde saklıyordu (FB-1006).
    else if (swept.skipped) logLine(`tts: yetim \`say\` süpürgesi atlandı (${swept.reason} — yerel say/afplay yalnız macOS'ta)`);
    else if (swept.reason) logLine(`tts: yetim süpürgesi koşamadı — ${swept.reason}`);
  } catch (e) {
    logLine(`tts: yetim süpürgesi hata verdi — ${e && e.message}`);
  }
  // MEMIDX-LEAK-01 — İNDEKSLEME ÇOCUKLARI UYGULAMAYLA BİRLİKTE GİDER (katman A).
  //
  // Ölçüldü (07.09 gecesi): bu kanca YOKKEN her açılış/kapanış bir yetim bıraktı —
  // 5/5 bare-run kapanışında worker ppid 1'e düştü ve 1968 dosyalık indekslemeye
  // saatlerce devam etti; gecede 48 yetim, loadavg 229 (14 çekirdek). Tek yer, iki
  // servis: ikisi de AYNI fork desenini kullanıyor, ikisi de aynı kuralı taşımalı.
  // Katman B (ebeveyn SIGKILL'lendiğinde koşan tek şey) çocuk tarafındadır:
  // childIpcSafe · installOrphanGuard.
  app.on('before-quit', () => {
    try { memoryIndexerSingleton?.shutdown(); } catch { /* kapanışı geciktirme */ }
    try { searchIndexSingleton?.stop(); } catch { /* kapanışı geciktirme */ }
    // TTS-ORPHAN-01 — AYNI LİSTEYE `say`/`afplay` DE GİRDİ. MEMIDX-LEAK-01 yalnız
    // indeks/gömme/arama çocuklarını kapatıyordu; yerel TTS çocuğu listede DEĞİLDİ
    // ve 07.09 gecesi 6 ebeveynsiz `say -o … "Tamam."` (ppid 1, biri 1 sa 30 dk)
    // bıraktı. Gerekçe ve üç katman: electron/jarvisVoice.js · TTS-ORPHAN-01.
    try { jarvisVoice.killLocalAudioChildren(); } catch { /* kapanışı geciktirme */ }
  });
  // ADP-440 — ekran görüntüleri AgentShot'a taşındı; eski kullanıcıya TEK SEFER bilgi.
  notifyScreenshotsMovedOnce();
  // ADP-625 — İLK AÇILIŞ DOKTORU: eksik dizinleri sessizce onarır, kalanını LOGLAR.
  // Bloklamaz, diyalog açmaz, kullanıcıyı rahatsız etmez — destek için tek satır
  // kanıt bırakır ve "Sistem Durumu" ekranı aynı raporu gösterir. Bağlantı yoklaması
  // ağ beklediği için await EDİLMEZ: pencere açılışını hiçbir koşulda geciktirmez.
  runDoctorNow()
    .then((report) => logLine(firstRunDoctor.formatDoctorLog(report)))
    .catch((e) => logLine(`[doctor] çalıştırılamadı: ${e && e.message}`));

  try {
    // Test-only escape hatch: attach to an ALREADY-running Next server instead of
    // spawning one. Lets the e2e harness drive a real `next dev` renderer (React
    // Strict Mode ON) without tripping Next 16's one-dev-server-per-dir lock.
    // Harmless in normal use (env unset) and never reached in a packaged app.
    const external = process.env.CREWPANE_EXTERNAL_URL;
    if (external) {
      logLine(`attaching to external server: ${external}`);
      createAppWindow(external);
      await startBridge();
      await startMobile(); // ADP-293 — yalnız enabled ise ayağa kalkar (kill-switch dosyada)
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createAppWindow(external);
      });
      return;
    }
    const url = await startNextServer(MODE);
    createAppWindow(url);
    await startBridge();
    await startMobile(); // ADP-293 — yalnız enabled ise ayağa kalkar (kill-switch dosyada)
    app.on('activate', () => {
      // ADP-816 — koşul "hiç pencere yok" DEĞİL "ANA pencere yok": ses widget'ı
      // (ya da bir pop-out) açıkken ana pencere kapatılırsa dock ikonuna basmak
      // eskiden HİÇBİR ŞEY yapmıyordu — uygulama geri getirilemez hâle geliyordu.
      if (!appWindow || appWindow.isDestroyed()) createAppWindow(url);
    });
  } catch (err) {
    logLine('FATAL: ' + err.message);
    noteQuit('fatal', err.message);
    app.quit();
  }
});

// TASK-MQSBV4EFQ8D6B — free a FINISHED worker's EXECUTION pane(s) so the next delegation
// auto-places into a fresh pane (the operator never closes panes by hand). Touches ONLY
// delegation execution panes (disallowSubagent === true, ADP-136) for this agentId — the
// LEADER, spawned without that flag, is structurally never recycled.
//
// ADP-266 — "free" is now a SOFT RESET, not a kill: the agent CLI keeps running and only its
// conversation is cleared (claude → /clear, codex → /new). Killing it produced the
// `[pty exited: 129]` (SIGHUP) the operator saw in every worker terminal after a delegation,
// threw away a warm session, and forced a 9s cold boot on the next dispatch. What the kill
// actually protected against — writing the next subtask into a STALE conversation — is what
// /clear removes. `shell`/unknown panes have no reset command, so they still get the kill.
//
// A session is not reset forever: after MAX_TASKS_PER_SESSION resets the pane is killed so a
// fresh process reclaims accumulated TUI scrollback / RSS. Returns how many panes were freed.
const MAX_TASKS_PER_SESSION = 10;
const RESET_ESC_GAP_MS = 150;
const RESET_SUBMIT_GAP_MS = 400; // ADP-048 two-step submit

// ENG-07 L2 — "yeni konuşma" komutu artık burada YAZILI DEĞİL, descriptor'dan okunur
// (`engineRegistry.capability(<motor>, 'reset')`). Kayıtsız motor / `shell` → `null` →
// pane geri dönüşümü soft-reset yerine KILL'e düşer (bugünkü nazik davranış aynen).
// Kayıp sessiz değil: `unsupported.reset` gerekçesi pane'in yetenek beyanına girer.
function resetCommandFor(command) {
  const cmd = engineRegistry.capability(command, 'reset');
  return typeof cmd === 'string' && cmd ? cmd : null;
}

function killPane(paneId, entry, agentId, why) {
  try { entry.child.kill(); } catch { /* already dead */ }
  ptys.delete(paneId);
  try { livePaneRegistry.freePane(paneId, crewpaneHome()); } catch { /* best-effort */ }
  // ADP-limit — a recycled worker pane's queued limit must not respawn it later.
  if (ptyResumeDaemon) { try { ptyResumeDaemon.forgetPane(paneId); } catch { /* best-effort */ } }
  logLine(`pane recycled (${why}) paneId=${paneId} agent=${agentId}`);
}

function softResetPane(paneId, entry, agentId, resetCmd) {
  // ESC discards a half-typed line; then the command is typed and submitted separately
  // (a single text+CR chunk drops the CR before the text registers — ADP-048).
  try { entry.child.write('\x1b'); } catch { return false; }
  setTimeout(() => {
    try { entry.child.write(resetCmd); } catch { return; }
    setTimeout(() => {
      try { entry.child.write('\r'); } catch { /* pane died mid-reset */ }
    }, RESET_SUBMIT_GAP_MS);
  }, RESET_ESC_GAP_MS);
  entry.lastResetAt = Date.now();
  entry.taskCount = (entry.taskCount || 0) + 1;
  logLine(`pane recycled (soft reset ${resetCmd}) paneId=${paneId} agent=${agentId} tasks=${entry.taskCount}`);
  return true;
}

function recycleWorkerPanes(agentId, mode = 'reset') {
  if (typeof agentId !== 'string' || !agentId) return 0;
  let freed = 0;
  for (const [paneId, entry] of [...ptys]) {
    if (entry.agentId !== agentId || entry.disallowSubagent !== true) continue;
    const resetCmd = mode === 'reset' ? resetCommandFor(entry.command) : null;
    const overBudget = (entry.taskCount || 0) + 1 >= MAX_TASKS_PER_SESSION;
    if (!resetCmd || overBudget) {
      killPane(paneId, entry, agentId, overBudget ? 'task budget spent' : 'delegation free');
    } else if (!softResetPane(paneId, entry, agentId, resetCmd)) {
      killPane(paneId, entry, agentId, 'reset write failed'); // safe degrade
    }
    freed++;
  }
  return freed;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADP-303 (C) — LİDER PANE KONTROLÜ. Optimus pane AÇabiliyordu (delegasyon) ama
// KAPATamıyordu: tek çıkış yolu pty süreçlerini elle kill etmekti → EPIPE çökme
// diyaloğu + `[pty exited: 143]` zombisi (2026-07-12 vakası). Bu üç fonksiyon
// bridge (`/panes`, `/pane/close`, `/pane/focus`) üzerinden delegate MCP'ye açılır.
//
// KAPATMA = X BUTONUNUN AYNISI: paneKill.killPaneExplicit (child kill + registry
// removePane + resume-daemon forgetPane) → child.onExit → renderer `pty:exit` →
// hücre UI'dan düşer (ADP-303 B). Ayrı bir "kapat" yolu YOK; tek yol = tek davranış.
// ─────────────────────────────────────────────────────────────────────────────

/** Live panes in the leader-facing shape (no buffers — leader context is scarce). */
function allPanesForControl() {
  const out = [];
  // STAT-D1 §KN-2 — statü BURADA türetilir ve özete taşınır. `listPanes` bunu zaten
  // yapıyordu ama lider yolu (`/panes` → MCP) `summarizePane`den geçtiği için statü
  // hiç ulaşmıyordu; lider label'a bakıp "Boşta" okuyordu (49 dk boyunca yalan).
  const now = Date.now();
  for (const [paneId, e] of ptys) {
    out.push(
      paneControl.summarizePane({
        paneId,
        ...e,
        status: agentRunner.statusFor(e.lastDataAt, now),
        // STAT-D2 §B-1 — GÖREV BAĞININ EKSİK AYAĞI. Statü (KN-2) bu yola taşındı ama
        // `labelTaskCode` YALNIZ `listPanes`te hesaplanıyordu; pty kaydında böyle bir
        // ALAN YOK, dolayısıyla `...e` yayılımı onu getiremez → lider/MCP satırı DAİMA
        // null görüyordu (STAT-QA1 ölçümü: 158 örnek). Tüketici bunu bekliyor:
        // `crewpane-delegate-mcp.cjs` → `p.taskId || p.labelTaskCode`. `p.taskId` de
        // yalnız worktree izolasyonu açıkken dolduğu için lider "bu pane hangi işi
        // koşuyor?"u hiç okuyamıyordu (yalan değil — KÖRLÜK; INV-1'in aynı satırdaki
        // yarısı). Çıkarım `listPanes` ile AYNI tek kaynaktan (`taskCode.cjs`) gelir;
        // ikinci bir regex YAZILMAZ (F-6 dersi).
        labelTaskCode: labelTaskCodeOf(e.label),
        exited: false,
      }),
    );
  }
  return out;
}

/**
 * ADP-717 — çağıranın KENDİ takımı. Kritik: payload'daki `department` çağıranın kendi
 * BEYANIDIR (env'den gelir, ajan onu değiştirebilir) — o değere yaslanan bir kural
 * kandırılabilir. Doğru kaynak: liderin KENDİ canlı pane kaydı; oradaki `department`
 * spawn anında roster'dan yazılır (agentRunner.withLeaderEnv ile aynı değer) ve ajan
 * ona erişemez. Pane bulunamazsa (pane'siz köprü çağrısı) beyana düşülür.
 */
function callerScopeFor(leaderId, declared) {
  const id = typeof leaderId === 'string' ? leaderId.trim() : '';
  if (id) {
    for (const e of ptys.values()) {
      if (e && e.agentId === id && e.department) return e.department;
    }
  }
  return typeof declared === 'string' ? declared : '';
}

/**
 * ADP-717 — TEK kapsam kararı (delege + sprint + pane). `teamScope.authorize`'ın
 * main tarafındaki tek çağrı noktası: politikayı ayarlardan, çağıranın kapsamını
 * canlı pane defterinden çözer. `once` izni başarılı bir delegasyonda TÜKETİLİR
 * (silinmez — `manage`'e döner ki başlatılan iş sonradan temizlenebilsin).
 */
function authorizeTeamScope({ action, leaderId, targetScope, force, targetStartedAt } = {}) {
  const policy = agentSettings.teamScopePolicy(app.getVersion());
  const decision = teamScope.authorize({
    action,
    callerId: leaderId,
    callerScope: callerScopeFor(leaderId, ''),
    targetScope,
    policy,
    force: force === true,
    targetStartedAt,
  });
  if (decision.ok && decision.via === 'grant' && action === 'delegate' && decision.grant && decision.grant.mode === 'once') {
    const consumed = teamScope.consumeGrant(policy.grants, decision.grant);
    if (consumed.changed) {
      agentSettings.writeSettings({ teamScope: { ...policy, grants: consumed.grants } });
      logLine(`team scope: tek-seferlik izin TÜKETİLDİ (leader=${leaderId} scope=${targetScope}) → yalnız yönetim`);
    }
  }
  logLine(
    `team scope: ${action} by=${leaderId || '-'} target=${targetScope || '-'} → ` +
      (decision.ok ? `İZİNLİ (${decision.via})` : `RED (${decision.code})`),
  );
  return decision;
}

// ---------------------------------------------------------------------------
// ADP-737 — ÇAPRAZ-TAKIM İZİN AKIŞI (sahibin onayı)
// ---------------------------------------------------------------------------
//
// ADP-717 kuralı doğru kurdu ama tek çıkışı vardı: RED + "Ayarlar'a git" metni. Bir
// üründe bu, işin ORTASINDA duran bir duvardır — üstelik ADP-729 §5'teki sahipsiz
// mandal yüzünden kullanıcı o duvarı hiç izin vermeden de görebiliyordu.
//
// Bu akış duvarı bir SORUYA çevirir: red anında SAHİBE (patron) tek kart çıkar
// (masaüstü Jarvis kartı + mobil — jarvisConversation defteri iki uçta da çizer),
// "Her zaman / Yalnız bu sefer / Reddet". Onay verilirse izin YAZILIR ve karar
// yeniden alınır — yani lider aynı çağrıda işine devam eder.
//
// DEĞİŞMEZLER:
//   • Karar hâlâ deterministik kodda (teamScope.authorize). Onay yalnız POLİTİKAYI
//     değiştirir; kart bir "evet" dönse bile authorize tekrar koşar.
//   • Ajanın/sayfanın metni izni yükseltemez: kart metnini MAIN yazar, payload'dan
//     yalnız kimlik/slug alanları geçer.
//   • Aynı (lider, hedef takım) için AÇIK bir kart varken ikinci kart açılmaz —
//     paralel worker'lar patrona onay yağmuru yağdırmasın.
//   • Cevap gelmezse iş BAŞLAMAZ (fail-closed): zaman aşımı = red.

/** Cevap beklenen çapraz-takım kartları: `${leaderId}→${targetScope}` → Promise. */
const crossTeamConsentPending = new Map();
/**
 * Kartın kendi ömrü: patron masasında olmayabilir, soru AÇIK kalsın (10 dk).
 * Cevap geldiğinde izin YAZILIR — çağıran çoktan pes etmiş olsa bile, çünkü liderin
 * bir sonraki denemesi o izinle geçmeli.
 */
const CROSS_TEAM_CARD_TTL_MS = 10 * 60 * 1000;
/**
 * ÇAĞIRANIN bekleme bütçesi. MCP istemcisinin HTTP zaman aşımı 20 sn
 * (`crewpane-delegate-mcp.cjs`): daha uzun beklersek lider temiz bir RED yerine
 * TAŞIMA HATASI görür ve köprüyü ölü sanır. Patron klavyedeyse bu süre yeter ve iş
 * AYNI çağrıda devam eder; değilse net bir mesajla reddedilir, kart açık kalır.
 */
const CROSS_TEAM_CONSENT_WAIT_MS = 10000;

/**
 * Sahibe çapraz-takım izni sor. Cevap geldiğinde İZNİ KENDİSİ YAZAR (çağıran beklemeyi
 * bırakmış olsa bile) ve cevabı döner.
 * @returns {Promise<'always'|'once'|'deny'>}
 */
function askCrossTeamConsent({ leaderId, callerScope, targetScope }) {
  const key = `${leaderId}→${targetScope}`;
  const inflight = crossTeamConsentPending.get(key);
  if (inflight) return inflight; // aynı soru zaten açık — ikinci kart açma

  const promise = new Promise((resolve) => {
    const approvalId = `tsc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let settled = false;
    let off = null;
    let timer = null;
    const finish = (answer) => {
      if (settled) return;
      settled = true;
      if (off) { try { off(); } catch { /* best-effort */ } }
      if (timer) clearTimeout(timer);
      crossTeamConsentPending.delete(key);
      if (answer !== 'deny') {
        // İzin YAZMA burada: çağıran beklemeyi bıraksa da patronun kararı kaybolmasın.
        const granted = agentSettings.grantTeamScope({
          leaderId,
          scopes: [teamScope.normalizeScope(targetScope)],
          mode: answer === 'once' ? 'once' : 'always',
        });
        logLine(`team scope: SAHİP İZİN VERDİ leader=${leaderId} target=${targetScope} mode=${answer} ok=${granted.ok}`);
      } else {
        logLine(`team scope: sahip İZİN VERMEDİ leader=${leaderId} target=${targetScope}`);
      }
      resolve(answer);
    };
    try {
      off = jarvisConv.onChange((event) => {
        if (!event || event.type !== 'approval-resolved' || event.approvalId !== approvalId) return;
        if (event.status !== 'allowed') return finish('deny');
        finish(event.choice === 'single' ? 'once' : 'always');
      });
      const opened = jarvisConv.openApproval({
        id: approvalId,
        title: 'Takım dışına iş verme izni',
        // Metni MAIN yazar; payload'dan yalnız kimlik/slug geçer (prompt izni yükseltemez).
        detail:
          `"${leaderId}" kendi takımının (${callerScope || 'bilinmiyor'}) DIŞINDA, ` +
          `"${targetScope}" takımından bir çalışana iş vermek istiyor.\n` +
          'İzin verirsen o takımın pane\'lerini kapatabilir de (yetki = yönetim).',
        source: 'desktop',
        // ADP-322 SÖZLÜĞÜ (kartın kendi dili): yalnız 'approve'/'single' İZİN sayılır,
        // diğer her seçenek RED'dir. Yeni bir id icat etmek kartı sessizce "reddet"
        // makinesine çevirirdi — bu yüzden mevcut vokabüler kullanılır.
        choices: [
          { id: 'approve', label: 'Her zaman izin ver' },
          { id: 'single', label: 'Yalnız bu sefer' },
          { id: 'cancel', label: 'Reddet' },
        ],
      });
      if (!opened) return finish('deny'); // kart açılamadı → fail-closed
      logLine(`team scope: İZİN SORULDU leader=${leaderId} target=${targetScope} approvalId=${approvalId}`);
      timer = setTimeout(() => {
        try { jarvisConv.closeApproval(approvalId, 'expired'); } catch { /* best-effort */ }
        logLine(`team scope: izin kartı SÜRESİ DOLDU (leader=${leaderId} target=${targetScope})`);
        finish('deny');
      }, CROSS_TEAM_CARD_TTL_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    } catch (err) {
      logLine(`team scope: izin kartı açılamadı: ${String((err && err.message) || err)}`);
      finish('deny');
    }
  });
  crossTeamConsentPending.set(key, promise);
  return promise;
}

/**
 * ADP-737 — kapsam kararı + (gerekirse) SAHİBİN ONAY AKIŞI. `/delegate`, `/sprint` ve
 * renderer'ın per-worker kapısı buradan geçer. Red `cross-team` DEĞİLSE (kapsamsız pane,
 * bozuk action…) soru sorulmaz: onun cevabı bir izin değildir.
 */
async function authorizeTeamScopeInteractive({ action, leaderId, targetScope, force, targetStartedAt } = {}) {
  const first = authorizeTeamScope({ action, leaderId, targetScope, force, targetStartedAt });
  if (first.ok || first.code !== 'cross-team') return first;

  const callerScope = callerScopeFor(leaderId, '');
  const consent = askCrossTeamConsent({ leaderId, callerScope, targetScope });
  // Çağıranın bütçesi kartın ömründen KISA (MCP 20 sn): süre dolarsa net bir RED
  // döneriz ama SORU AÇIK KALIR — patron sonra onaylarsa izin yazılır ve liderin
  // bir sonraki denemesi geçer. Sessizce asılı kalan bir çağrı en kötü seçenekti.
  let timer = null;
  const answer = await Promise.race([
    consent,
    new Promise((r) => {
      timer = setTimeout(() => r('pending'), CROSS_TEAM_CONSENT_WAIT_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]);
  if (timer) clearTimeout(timer);

  if (answer === 'pending') {
    return {
      ...first,
      code: 'cross-team-consent-pending',
      reason:
        `${first.reason}\n(Sahibine SORULDU — masaüstündeki/telefondaki izin kartı açık. ` +
        'İzin verilince aynı isteği tekrar gönder.)',
    };
  }
  if (answer === 'deny') {
    return {
      ...first,
      reason: `${first.reason}\n(Sahibine soruldu; izin VERİLMEDİ.)`,
    };
  }
  // İzin `askCrossTeamConsent` içinde YAZILDI. Karar YENİDEN alınır — "evet" cevabı
  // kararın yerine geçmez, yalnız politikayı değiştirir.
  return authorizeTeamScope({ action, leaderId, targetScope, force, targetStartedAt });
}

/**
 * Panes a caller may see. ADP-717: the filter moved OUT of the MCP client (where the
 * caller could simply not apply it) into the server, and it uses the SAME authorize()
 * as close/focus — what you can see is what you can manage.
 */
function listPanesForControl(caller = {}) {
  const all = allPanesForControl();
  const leaderId = (caller && typeof caller.leaderId === 'string' ? caller.leaderId : '').trim();
  if (!leaderId) return all; // kimliksiz çağrı (UI/iç kullanım) — süzme yok
  return teamScope.visiblePanes(all, {
    callerId: leaderId,
    callerScope: callerScopeFor(leaderId, caller.department),
    policy: agentSettings.teamScopePolicy(app.getVersion()),
  });
}

/**
 * Close panes for a leader. `payload` = { leaderId?, department?, force?, filter:{paneId|agentId|exitedOnly|all} }.
 * Scope + self-protection decided in paneControl (unit-tested); executed here.
 */
function closePanesForControl(payload = {}) {
  const filter = payload.filter && typeof payload.filter === 'object' ? payload.filter : {};
  const leaderId = typeof payload.leaderId === 'string' ? payload.leaderId : '';
  const caller = {
    agentId: leaderId,
    // ADP-717 — çağıranın kapsamı BEYANDAN değil, kendi canlı pane kaydından çözülür.
    department: callerScopeFor(leaderId, payload.department),
    force: payload.force === true,
    // ADP-717 — kapsam kararının verisi (izinler + yürürlük mandalı) authorizeClose'a
    // buradan geçer; karar teamScope.authorize'da, delegasyonla ORTAK.
    policy: agentSettings.teamScopePolicy(app.getVersion()),
  };
  const plan = paneControl.planClose(allPanesForControl(), filter, caller);
  if (!plan.ok) {
    logLine(`pane control: close REFUSED by=${caller.agentId || '-'} reason=${plan.error}`);
    return { ok: false, error: plan.error };
  }
  const closed = [];
  for (const p of plan.close) {
    const entry = ptys.get(p.paneId);
    if (!entry) continue;
    const res = paneKill.killPaneExplicit({
      paneId: p.paneId,
      entry,
      isQuitting: app.isQuitting === true,
      registry: livePaneRegistry,
      homedir: crewpaneHome(),
      resumeDaemon: ptyResumeDaemon,
      log: logLine,
    });
    if (res.killed) {
      ptys.delete(p.paneId);
      closed.push(p.paneId);
    }
  }
  // AUDIT — who closed what, and what was refused (shell log is the audit trail).
  logLine(
    `pane control: close by=${caller.agentId || '-'} dept=${caller.department || '-'} ` +
      `filter=${JSON.stringify(filter)} force=${caller.force} closed=[${closed.join(',')}] ` +
      `denied=[${plan.denied.map((d) => d.paneId).join(',')}]`,
  );
  return { ok: true, closed, denied: plan.denied };
}

/** Bring a pane to the front (window + team + terminals view + xterm focus, via the renderer). */
function focusPaneForControl(paneId, caller = {}) {
  const id = String(paneId || '');
  const entry = ptys.get(id);
  if (!entry) return { ok: false, error: `no such pane: ${id}` };
  // ADP-717 — odaklama da YÖNETİMDİR: yönetemeyeceğin pane'i öne çekemezsin (aynı karar).
  const leaderId = typeof caller.leaderId === 'string' ? caller.leaderId.trim() : '';
  if (leaderId) {
    const scoped = authorizeTeamScope({
      action: 'manage',
      leaderId,
      targetScope: entry.department,
      force: true, // kapsamsız (shell) pane'i odaklamak zararsız — kapatmak değil
      targetStartedAt: entry.startedAt,
    });
    if (!scoped.ok) return { ok: false, code: scoped.code, error: scoped.reason };
  }
  const win = entry.win && !entry.win.isDestroyed() ? entry.win : appWindow;
  if (!win || win.isDestroyed()) return { ok: false, error: 'no app window' };
  // ADP-263 already wired the renderer side (JARVIS_FOCUS_PANE_EVENT: switch wing → show the
  // terminals view → focus the xterm); this IPC just feeds that same path from main.
  win.webContents.send('pane:focus', { paneId: id });
  try {
    win.show();
    win.focus();
  } catch { /* best-effort */ }
  logLine(`pane control: focus paneId=${id} agent=${entry.agentId ?? '-'}`);
  return { ok: true, paneId: id };
}

// ─────────────────────────────────────────────────────────────────────────────
// ADP-293 — MOBİL GATEWAY (ADR-020). AYRI yüzey: sabit port + tailnet adresi +
// cihaz-eşleşmeli token. delegationBridge'e DOKUNULMAZ (loopback + efemer + asla
// tünellenmez). Varsayılan READ-ONLY; yazma rotaları ADP-296.
// ─────────────────────────────────────────────────────────────────────────────
const mobileGatewayMod = require('./src/mobile/mobileGateway.js');
const mobileDeviceStore = require('./src/mobile/mobileDeviceStore.cjs');
// MOB-UX-M1 (M1-b) — sihirbazın ölçüm ucu (gateway KAPALIYKEN de cevap verir).
const mobileProbe = require('./src/mobile/mobileProbe.cjs');
const mobileOffice = require('./src/mobile/mobileOffice.cjs'); // ADP-334 — ofis MAIN'de derlenir
const mobileReports = require('./src/mobile/mobileReports.cjs'); // ADP-364 — raporlar MAIN'de (INDEX.md)
const mobileTranscript = require('./src/mobile/mobileTranscript.cjs'); // ADP-368 — okuma modu (claude oturum JSONL'i)
const mobileUploads = require('./src/mobile/mobileUploads.cjs'); // ADP-371 — telefondan görsel yükleme (prompt eki)
let mobileGateway = null;

// ─────────────────────────────────────────────────────────────────────────────
// ADP-317 — JARVİS KONUŞMASI: TEK DEFTER (main). Renderer paneli ve telefon AYNI
// kaynaktan okur/yazar → "iki Jarvis" yok. Her mutasyon TEK olay üretir; o olay
// hem tüm pencerelere (IPC) hem de mobil SSE'ye yayılır.
// ─────────────────────────────────────────────────────────────────────────────
const jarvisConversationMod = require('./src/voice/jarvisConversation.cjs');
const jarvisConv = jarvisConversationMod.createConversation({ log: logLine });

jarvisConv.onChange((event) => {
  // 1) Masaüstü paneli — açık her pencereye (telefondan gelen satır ANINDA görünür).
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) w.webContents.send('jarvis:conv:changed', event);
    } catch {
      /* kapanan pencere akışı düşürmez */
    }
  }
  // 2) Telefon — SSE (/m/stream). Masaüstünde yazılan satır ANINDA telefona düşer.
  if (event.type === 'turn') {
    emitMobileEvent({ type: 'jarvis-turn', turn: event.turn, at: event.turn.at });
  } else if (event.type === 'approval') {
    const a = event.approval;
    // ADP-322 — `choices` de gider: fan-out kartı TELEFONDA da 4 butonlu çıkar
    // (boşsa telefon eski ikili kartı çizer — regresyonsuz).
    emitMobileEvent({ type: 'approval', approvalId: a.id, title: a.title, detail: a.detail, choices: a.choices, at: a.at });
  } else if (event.type === 'approval-resolved') {
    // Bir uçta cevaplandı → diğer uçtaki kart KAPANIR (çift onay yok).
    emitMobileEvent({ type: 'approval-resolved', approvalId: event.approvalId, status: event.status, choice: event.choice ?? null, at: Date.now() });
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ASK-CARD-01 (FB-1009) — LİDERİN KARAR SORUSU: pane üstünde kart + "cevap bekliyor".
// Tespit ve defter `electron/paneAsk.cjs`te (saf, test edilir). Burada yalnız dikişler:
//   • ekran  → `entry.screen.liveLines()` (mobil VT'nin görünür satırları; kullanıcının
//              gördüğü metin — ham buffer değil)
//   • teslim → ENT-F1 `deliverToPane` (AXP-03 ile AYNI primitif: metin bir kez + Enter)
//   • yayın  → tüm pencereler (`paneAsk:changed`); telefon AYNA üzerinden (aşağıda)
//   • ayna   → Agent X onay defteri (`jarvisConv.openApproval`): telefon JarvisScreen ve
//              masaüstü Agent X kartı aynı düğmeleri çizer; cevap tek-kazanan kapısından
//              geçip BURADAN teslim edilir (`onMirrorResolved`). Seçeneksiz ya da 4'ten
//              çok seçenekli soru aynalanmaz (kart 4 düğme taşır; yarım liste yanıltır).
// ─────────────────────────────────────────────────────────────────────────────
const PANE_ASK_MIRROR_MAX = 4;
const paneAskMirrored = new Set();
const paneAskRuntime = paneAskMod.createPaneAskRuntime({
  readScreenLines: (paneId) => {
    const e = ptys.get(paneId);
    if (!e) return null;
    if (e.screen && typeof e.screen.liveLines === 'function') {
      const lines = e.screen.liveLines();
      if (Array.isArray(lines)) return lines;
    }
    // VT yoksa (patolojik) ham tampondan düş — cleanPaneTail satırlaştırır.
    const clean = delegationBridgeMod.cleanPaneTail(e.buffer || '', 60);
    return clean ? clean.split('\n') : [];
  },
  paneInfo: (paneId) => {
    const e = ptys.get(paneId);
    return e ? { agentId: e.agentId || null } : null;
  },
  deliver: (paneId, text) => deliverToPane(paneId, text, { submitGapMs: REFRESH_SUBMIT_GAP_MS, label: 'karar-kartı' }),
  emit: (event) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { if (!w.isDestroyed()) w.webContents.send('paneAsk:changed', event); } catch { /* kapanan pencere */ }
    }
    // Telefona AYRI bir SSE tipi gitmez: mobil sözleşme (mobileApiTypes.MobileEvent)
    // kapalı kümedir ve telefon kartı zaten AYNADAN (`approval`) alır.
  },
  mirror: {
    open: (ask) => {
      if (!ask.options.length || ask.options.length > PANE_ASK_MIRROR_MAX) return;
      const e = ptys.get(ask.paneId);
      const who = (e && (e.label || e.agentId)) || ask.agentId || '';
      const opened = jarvisConv.openApproval({
        id: ask.id,
        title: appI18n.t('main.ask.title', { agent: who }),
        detail: `${ask.question}\n${ask.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n')}`,
        source: 'desktop',
        choices: ask.options.map((o) => ({ id: o.id, label: o.label })),
      });
      if (opened) paneAskMirrored.add(ask.id);
    },
    close: (askId) => {
      if (!paneAskMirrored.delete(askId)) return;
      try { jarvisConv.closeApproval(askId, 'expired'); } catch { /* zaten kapalı */ }
    },
  },
  log: (line) => logLine(line),
});
// Ayna cevaplandı (telefon / Agent X kartı) → seçim BURADAN teslim edilir.
jarvisConv.onChange((event) => {
  if (!event || event.type !== 'approval-resolved') return;
  if (!paneAskMirrored.has(event.approvalId)) return;
  paneAskMirrored.delete(event.approvalId);
  if (event.status === 'expired') return; // bizim kapatmamız (close) — yankı
  void paneAskRuntime.onMirrorResolved(event.approvalId, event.status, event.choice || null);
});
ipcMain.handle('paneAsk:list', () => paneAskRuntime.list());
ipcMain.handle('paneAsk:answer', (_e, p) => {
  const o = p && typeof p === 'object' ? p : {};
  return paneAskRuntime.answer({
    askId: String(o.askId || ''),
    choiceId: typeof o.choiceId === 'string' && o.choiceId ? o.choiceId : null,
    text: typeof o.text === 'string' ? o.text : '',
    via: 'card',
  });
});
ipcMain.handle('paneAsk:dismiss', (_e, askId) => paneAskRuntime.dismiss(String(askId || '')));
/** SSE dinleyicileri (gateway subscribe eder; pty/renderer olayları buraya düşer). */
const mobileSubscribers = new Set();
function emitMobileEvent(event) {
  if (mobileSubscribers.size === 0) return;
  for (const cb of mobileSubscribers) {
    try {
      cb(event);
    } catch {
      /* tek dinleyici hatası akışı düşürmez */
    }
  }
}

/**
 * ADP-324 — bir pane'in seq'li tail'i: VT EKRANINDAN (satır listesi + canlı satırlar).
 * `opts`: { lines, before, since } — sayfalama/boşluk doldurma (bkz. paneScreen.cjs).
 * Ekranı olmayan (eski/patolojik) pane'de rolling buffer'a düşülür — kırılmaz.
 */
function mobilePaneTail(paneId, opts = {}) {
  const entry = ptys.get(String(paneId || ''));
  if (!entry) return null;
  if (entry.screen) return entry.screen.tail(opts);
  const clean = delegationBridgeMod.cleanPaneTail(entry.buffer || '', opts.lines || 200);
  const arr = clean ? clean.split('\n') : [];
  return {
    entries: arr.map((text, i) => ({ seq: i + 1, text })), // sentetik seq — sayfalama YOK
    live: [],
    firstSeq: arr.length ? 1 : 0,
    lastSeq: arr.length,
    hasMore: false,
    truncated: (entry.bytes || 0) > (entry.buffer || '').length,
  };
}

/**
 * ADP-368 — OKUMA MODU sayfası: pane'in claude oturum defterinden (JSONL) yapılandırılmış
 * sohbet öğeleri. Pane→{cwd,sessionId} çözümü pty defterinden (ADP-280 teslim-doğrulama
 * ile aynı kaynak); transcript'i olmayan pane (codex/shell) supported:false döner ve
 * telefon ham VT görünümüne düşer. Pane yoksa null → gateway 404 basar.
 */
function mobilePaneTranscript(paneId, opts = {}) {
  const entry = ptys.get(String(paneId || ''));
  if (!entry) return null;
  // ADP-586 — telefon de aynı transcript dosyasını okur; maskeleme masaüstü IPC'siyle
  // AYNI olmalı (yoksa "ekranda maskeli, telefonda düz" gibi bir delik kalırdı).
  return secretRedactor.redactDeep(mobileTranscript.readTranscriptPage({
    cwd: entry.cwd,
    // ADP-705 — `/clear` sonrası GÜNCEL oturum (bkz. currentSessionId).
    sessionId: currentSessionId(String(paneId || '')),
    // CDX-READ-02 — masaüstüyle AYNI motor-bağımsız defter çözümü (telefon da codex okur).
    startedAt: entry.startedAt ?? null,
    engine: entry.command ?? null,
    limit: opts.limit,
    before: opts.before,
    // ADP-738 — kırpma tavanı YALNIZ ağ yüzeyinde: telefon bir sayfada megabaytlarca
    // markdown çekmesin. Kesme markdown-güvenli sınıra çekilir + `textTruncated`
    // bayrağı yanar (mobil "…mesaj sunucuda kısaltıldı" notunu gösterir). Masaüstü
    // IPC'si (pty:transcriptPage) tavan GEÇMEZ → okunabilir mod veri düşürmez.
    maxText: mobileTranscript.MAX_TEXT,
  }));
}

/** Mobil pane listesi (tam tampon YOK — son satır + statü). */
function mobileListPanes() {
  const out = [];
  for (const [paneId, e] of ptys) {
    // ADP-324 — `lastLine` VT ekranından ve KIRPILMIŞ gelir (200 kr). Eskiden ham tampondan
    // türetiliyordu: tek TUI satırı 171.800 karaktere ulaşıyor, liste 766 KB'a şişiyordu.
    const tail = e.screen ? e.screen.lastLine() : delegationBridgeMod.cleanPaneTail(e.buffer || '', 1).slice(0, 200);
    out.push({
      paneId,
      agentId: e.agentId ?? null,
      label: e.label ?? null,
      department: e.department ?? null,
      command: e.command,
      status: agentRunner.statusFor(e.lastDataAt, Date.now()),
      startedAt: e.startedAt,
      lastLine: tail || '',
    });
  }
  return out;
}

/** Renderer'a soru sor (office/delegations/tasks) — köprünün callRenderer deseni. */
const mobilePending = new Map();

// ADP-326 — `params` (arama/filtre/sayfalama · taskId · free) gateway'de SÜZÜLÜR,
// burada yalnız TAŞINIR: sorguyu renderer'ın mevcut Supabase yüzeyi kurar.
function mobileQueryRenderer(kind, params, timeoutMs = 8000) {
  const win = appWindow;
  if (!win || win.isDestroyed()) return Promise.reject(new Error('uygulama penceresi yok'));
  const requestId = crypto.randomBytes(12).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mobilePending.delete(requestId);
      reject(new Error('renderer timeout'));
    }, timeoutMs);
    mobilePending.set(requestId, { resolve, timer });
    win.webContents.send('mobile:query', { requestId, kind, params: params || {} });
  });
}

// ADP-296 — YAZMA komutları: gateway → main → renderer (mevcut motorlar orada:
// sendCommandToAgent / startTeamDelegationEx / executeDecision / executeBoard).
// Main hiçbir iş mantığı çalıştırmaz; yalnız korelasyonlu taşır (query deseninin ikizi).
const mobileCommandPending = new Map();

function mobileCommandRenderer(kind, payload) {
  const win = appWindow;
  if (!win || win.isDestroyed()) return Promise.reject(new Error('uygulama penceresi yok'));
  const requestId = crypto.randomBytes(12).toString('hex');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      mobileCommandPending.delete(requestId);
      reject(new Error('renderer timeout'));
    }, 44000); // gateway'in COMMAND_TIMEOUT_MS'inden hemen önce düşer (dürüst hata)
    mobileCommandPending.set(requestId, { resolve, timer });
    win.webContents.send('mobile:command', { requestId, kind, payload: payload || {} });
  });
}

/**
 * ADP-334 — /m/office MAIN'de derlenir. Renderer'a SORULMAZ; tek istisna delegasyon
 * DURUMU: uçuştaki delegasyonların motoru renderer-ömürlüdür (delegationRunner), o
 * yüzden pencere AÇIKSA gerçeği ondan alırız. Pencere KAPALIYSA uçuşta delegasyon
 * olamaz (pane'leri de öldürülür) → diskteki kuyruk defteri (kuyruk + limitte
 * duraklamış kayıtlar) dürüst cevaptır. Renderer cevap vermezse de aynı yere düşeriz:
 * ofis 503 vermez, DEĞERLİ olanı (roster + pane'ler) yine gösterir.
 */
async function mobileDelegationState() {
  const win = appWindow;
  if (win && !win.isDestroyed()) {
    try {
      // Kısa bütçe: ofisin TAMAMI gateway'de 8sn'lik bir bütçeye sığmalı — takılan bir
      // renderer ofisi düşürmesin, sadece delegasyon sayaçlarını diske düşürsün.
      return await mobileQueryRenderer('delegation-state', {}, 3000);
    } catch { /* renderer yok/yavaş → diske düş */ }
  }
  return mobileOffice.delegationStateFromQueue(delegationQueueStore.loadQueueState());
}

// ADP-773 — MOBİL OFİS, MASAÜSTÜYLE AYNI HEDEFTEN OKUR.
//
// Eskiden burada `publicSupabaseEnv()`ten yalnız url+anahtar alınıyordu; ADP-621'in
// `schema` alanı (bulutta 'app') ve ADP-622'nin kimliği taşınmıyordu → PostgREST
// varsayılan `public` şemasına baktı ve /m/office "HTTP 404" ile öldü (masaüstü
// çalışıyordu çünkü rendererSupabaseTarget() ikisini de veriyor).
//
// KURAL: hedef İKİNCİ KEZ türetilmez — renderer'a giden `rendererSupabaseTarget()`
// aynen okunur. Şema/tablo sözleşmesi değişirse iki yüzey birlikte değişir.
function mobileOfficeSnapshot() {
  const target = rendererSupabaseTarget();
  return mobileOffice.officeSnapshot({
    supabase: { url: target.url, key: target.anonKey, schema: target.schema },
    // `appdb:token` IPC'si ve delegasyon köprüsünün `onAppDbToken`u ile AYNI kaynak
    // (seatGate). Oturum yoksa/lisans kapalıysa `ok:false` döner → istek anon'a düşer
    // ve yerel/e2e (public şema) yolu bugünkü gibi çalışmaya devam eder.
    accessToken: mobileAppDbToken,
    listPanes: mobileListPanes,
    delegationState: mobileDelegationState,
  });
}

// ---------------------------------------------------------------------------
// ADP-352 (ADR-024 §5-c) — AGENTSHOT KÖPRÜSÜ: "çekimi ajana gönder"
// ---------------------------------------------------------------------------
// Bağımsız AgentShot (ayrı app, ayrı depo ~/.agentshot) ücretsizdir ve İÇİNDE AI
// analizi YOKTUR (ADR-024 §5: ücretsiz üründe açık uçlu COGS). CrewPane kuruluysa
// çekim buradan kullanıcının KENDİ ajanına düşer → analiz onun kendi claude CLI
// aboneliğinde koşar (COGS $0).
//
// YENİ TESLİM MANTIĞI YOK: ADP-371'in (mobil görsel) yolu birebir yeniden kullanılır —
// mobileCommandRenderer('prompt', {attachmentPaths}) → renderer cmdPrompt →
// withAttachments("[Ekli görsel — Read aracıyla aç: <yol>]") → sendCommandToAgent.
// Tek fark: AgentShot BAYT YÜKLEMEZ (dosya zaten aynı diskte), yalnız YOL taşır.
//
// SHOT-NOENTER-01 — ve bu rota `submit:false` geçer: metin composer'a YAZILIR,
// Enter BASILMAZ (state:'inserted'). Telefon/delege yolları bayrağı geçmez.

const SHOT_BRIDGE_MAX_BYTES = 25 * 1024 * 1024; // makul PNG tavanı (5K tam ekran ~10MB)

/** Köprüden gelen "kime gönderebilirim?" — ofis anlık görüntüsündeki ajanlar. */
async function shotBridgeAgents() {
  const office = await mobileOfficeSnapshot();
  return (office && Array.isArray(office.agents) ? office.agents : []).map((a) => ({
    agentId: a.agentId,
    displayName: a.displayName,
    department: a.department,
    role: a.role,
    status: a.status,
  }));
}

/**
 * Köprüden gelen çekim(ler) → ajanın pane'i. Dosya VARLIĞI burada ölçülür (fs main'de).
 *
 * TASK-MRZ9EAKX2LIJO — ÇOKLU: `paths` birden fazla çekim taşıyabilir ve hepsi TEK
 * prompt'a iliştirilir (attachmentPaths ZATEN dizidir — ADP-371 yolu; withAttachments
 * "[Ekli görsel i/N — Read aracıyla aç: …]" satırlarını sırayla üretir). Yani N görsel
 * = N istek DEĞİL, tek dispatch. Tekil `path` (eski AgentShot menüsü) aynen çalışır.
 */
async function shotBridgeSend({ path: shotPath, paths, agentId, text }) {
  const list = Array.isArray(paths) && paths.length ? paths : (shotPath ? [shotPath] : []);
  if (!list.length) return { ok: false, reason: 'not-found', error: 'görsel yolu yok' };
  for (const p of list) {
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      return { ok: false, reason: 'not-found', error: `görsel bulunamadı: ${p}` };
    }
    if (!st.isFile()) return { ok: false, reason: 'not-found', error: `görsel bir dosya değil: ${p}` };
    if (st.size > SHOT_BRIDGE_MAX_BYTES) return { ok: false, error: `görsel çok büyük (tavan 25MB): ${p}` };
  }
  return mobileCommandRenderer('prompt', {
    agentId,
    text: typeof text === 'string' ? text : '',
    attachmentPaths: list,
    // SHOT-NOENTER-01 — INSERT-ONLY: çekim yolları ajanın composer'ına YAZILIR ama
    // Enter BASILMAZ. Eren çekimi gönderdikten sonra "şu butona bak" gibi kendi
    // cümlesini peşine ekleyip Enter'a KENDİSİ basar; otomatik gönderim onu bu
    // fırsattan mahrum bırakıyordu. Bayrak YALNIZ bu rotadan geçer — telefonun
    // /m/prompt yolu bayrağı hiç yollamaz, orada davranış bit-bit aynı kalır.
    submit: false,
  });
}

/** ADP-296 — telefondan gelen sesin transkripti MAC'te (OpenAI anahtarı burada kalır). */
function mobileTranscribe(payload) {
  return jarvisVoice.transcribeWhisper({ ...(payload || {}), apiKey: jarvisVoice.openAiKey(REPO_ROOT) });
}

/**
 * BL-02 — MOBİL UZAKTAN KONTROL TAVANI. TEK boğaz burasıdır, çünkü gateway'e giden
 * İKİ yol var: (1) açılışta defterde `enabled:true` görünce kendiliğinden kalkmak,
 * (2) kullanıcının "Mobil erişimi aç" düğmesi. Yalnız düğmeyi kapatmak, Pro'dayken
 * açıp Basic'e düşen kullanıcıda özelliği her açılışta SESSİZCE geri verirdi.
 *
 * Sıra önemli: karar defter YAZILMADAN ÖNCE sorulur — reddedilen bir eylem kalıcı
 * durumu değiştiremez (aksi hâlde `enabled:true` diskte kalır ve yükseltme anında
 * kullanıcının hiç onaylamadığı bir sunucu açılırdı).
 *
 * `notify` KİMİN eylemi olduğunu söyler: kullanıcı düğmeye bastıysa ret EKRANA
 * basılır; açılışta kendiliğinden denenen kalkış yalnız LOG'a düşer (gerekçesi
 * planDenial'ın başında — ölçülmüş bir kusur).
 * @returns {object|null} denial ya da null (izinli)
 */
function mobilePlanDenial({ notify = true } = {}) {
  return planDenial('mobileRemote', 0, { notify });
}

async function startMobile() {
  if (mobileGateway) return mobileGateway;
  // Açılıştaki otomatik kalkış SESSİZ reddedilir (kullanıcı bir şey istemedi);
  // `mobile:enable` kendi kararını notify:true ile ZATEN vermiş olur.
  const planGate = mobilePlanDenial({ notify: false });
  if (planGate) {
    logLine(`mobile gateway: plan tavanı — kalkmadı (katman=${planGate.tier}); cihaz defteri diskte KORUNUYOR`);
    return null;
  }
  try {
    mobileGateway = await mobileGatewayMod.startMobileGateway({
      log: logLine,
      // ADP-372 — masaüstü kimliği /m/health'e: telefonun Cihaz sekmesi "masaüstü hangi
      // sürüm/commit'te?" sorusunu buradan cevaplar (SHELL_COMMIT = ADP-268 kaynağı;
      // packaged'da extraMetadata.gitCommit, kaynaktan koşarken git rev-parse).
      appInfo: { version: app.getVersion(), commit: SHELL_COMMIT },
      // ADP-313 — mobil ajan kartlarındaki pixel sprite'lar masaüstü ofisiyle AYNI
      // PNG'lerden gelir (ikinci kopya YOK): public/sprites/characters/<key>/48x48.png
      spriteDir: mobileSpriteDir(),
      // ADP-556 — mobil arayüz BUILT-IN: expo web export'u gateway'den sunulur;
      // telefon dev server olmadan http://<tailnet-ip>:7823/ açar.
      webRoot: mobileWebRoot(),
      listPanes: mobileListPanes,
      paneTail: mobilePaneTail,
      // ADP-368 — okuma modu: claude oturum JSONL'inden yapılandırılmış sayfa (main'de,
      // pencere kapalıyken de gelir; VT bozulma sınıfı bu kaynakta imkânsız).
      paneTranscript: mobilePaneTranscript,
      queryRenderer: mobileQueryRenderer,
      // ADP-334 — OFİS main'de: roster+sprite Supabase'ten, pane'ler pty defterinden,
      // delegasyon durumu renderer'dan (varsa) ya da disk kuyruğundan. Uygulama
      // penceresi KAPALIYKEN de telefon ofisi görür (eskiden 503'tü).
      officeSnapshot: mobileOfficeSnapshot,
      // ADP-364 — RAPORLAR: docs/agent-results/INDEX.md main'de parse edilir (ofis gibi;
      // renderer'a/Supabase'e sorulmaz → pencere kapalıyken de telefon raporları görür).
      reportsList: (params) => mobileReports.listReports({ params }),
      reportRead: (reportId, opts) => mobileReports.readReport({ reportId, page: opts && opts.page }),
      command: mobileCommandRenderer, // ADP-296
      transcribe: mobileTranscribe, // ADP-296 (sesli Jarvis)
      // ADP-371 — GÖRSEL: baytlar main'de diske düşer (renderer'a uğramaz); prompt'taki
      // uploadId'ler yine main'de mutlak yola çözülür (regex + kök-kontrolü traversal'ı keser).
      saveUpload: (p) => mobileUploads.saveUpload(p),
      resolveUpload: (id) => mobileUploads.resolveUpload(id),
      // ADP-317 — telefon açılışta AYNI defteri okur (renderer'a hiç sormadan; uygulama
      // penceresi kapalı/uykuda olsa bile konuşma geçmişi gelir).
      // ADP-329 — SAYFALANMIŞ defter: telefon açılışta son N satırı alır, yukarı
      // kaydırınca `before` imleciyle geriye gider (tam defter artık gitmiyor).
      jarvisHistory: (q) => jarvisConv.history(q),
      killSwitch: mobileKillSwitch, // ADP-296 (telefondan acil kapatma)
      subscribe: (cb) => {
        mobileSubscribers.add(cb);
        return () => mobileSubscribers.delete(cb);
      },
    });
  } catch (err) {
    logLine(`mobile gateway failed to start: ${err.message}`);
    mobileGateway = null;
    // WIN-DUP-INSTANCE-01 (FB-1012) — sebep saklanır; `mobile:enable` sihirbaza
    // İNSAN cümlesi döndürür (port dolu = bilgisayarda başka bir CrewPane açık).
    mobileGatewayLastFailure = mobileStartFailure(err);
  }
  // ADP-371 — yükleme temizliği: açılışta + günde bir, KEEP_DAYS'ten eski gün
  // klasörleri silinir. Callback İÇİ try/catch ADP-335 kuralı (asenkron hata
  // çağrı yerindeki catch'e uğramaz — app'i öldürmesin).
  if (mobileGateway && !mobileUploadsSweepTimer) {
    const sweep = () => {
      try {
        const n = mobileUploads.sweepUploads({});
        if (n) logLine(`mobile uploads: ${n} eski gün klasörü temizlendi`);
      } catch (err) {
        logLine(`mobile uploads: temizlik hatası: ${err.message}`);
      }
    };
    sweep();
    mobileUploadsSweepTimer = setInterval(sweep, 24 * 60 * 60 * 1000);
    mobileUploadsSweepTimer.unref?.();
  }
  return mobileGateway;
}
let mobileUploadsSweepTimer = null;
/** WIN-DUP-INSTANCE-01 — son gateway kalkış hatası: {reason, error} ya da null. */
let mobileGatewayLastFailure = null;
/**
 * WIN-DUP-INSTANCE-01 (FB-1012) — gateway kalkış hatasını SİHİRBAZ cümlesine çevir.
 * Gövde saf modülde (electron/mobileStartFailure.cjs — Electron'suz test edilir);
 * burada yalnız sözlük bağlanır. Cümlede iç mekanizma YOK: port, hata kodu yazılmaz.
 * @returns {{reason:'port_in_use'|'start_failed', error:string}}
 */
function mobileStartFailure(err) {
  const i18nMod = require('./i18n/index.cjs');
  return require('./src/mobile/mobileStartFailure.cjs').mobileStartFailure(err, (k) => i18nMod.t(k));
}

/** Mobil erişimi kes: defterde enabled:false (restart'ta da kapalı) + sunucuyu durdur. */
function mobileKillSwitch() {
  const state = mobileDeviceStore.loadState();
  state.enabled = false;
  mobileDeviceStore.saveState(state);
  if (mobileGateway) {
    mobileGateway.stop();
    mobileGateway = null;
  }
  logLine('mobile gateway: KILL-SWITCH — mobil erişim kapatıldı');
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYNC-F1-6 — BULUT SENKRONU: motorun açılışa bağlandığı ÜÇ SATIR (§16.7'nin borcu)
// ═══════════════════════════════════════════════════════════════════════════════
// Kuruluşun KENDİSİ burada değil `electron/sync/syncBoot.cjs`tedir (bu dosya
// Electron olmadan require edilemez → orada yaşayan bir kuruluş `node --test` ile
// sınanamazdı). Burada yalnız bağlar var:
//   • plan kanalı  — `seatGate.state()` (ZORUNLU DI, §18.1/3)
//   • kökler       — çözülmüş çalışma alanı + bağlı hesap kökü
//   • indeks kancası — F1-4'ün `createDeriveIndexesHook`u; senkron dosya indirince
//     MEMORY.md İNDİRİLMEZ, TÜRETİLİR (§3.4). Kanca verilmezse motor NO-OP'a düşer
//     ve indeks bayat kalırdı — bu yüzden wiring aynı commit'te.
// ═══════════════════════════════════════════════════════════════════════════════
// SYNC-F1-7 — TERCİH PROJEKTÖRÜ: `settings.json` ⇄ `prefs/app-prefs.json`
// ═══════════════════════════════════════════════════════════════════════════════
// `settings.json` SENKRONLANMAZ (sır taşır ve hiçbir senkron sınıfının alt
// ağacında DEĞİLDİR). Buradaki projektör beyaz listeli anahtarların bir
// PROJEKSİYONUNU üretir; senkron motoru onu NORMAL BİR DOSYA gibi taşır.
//
// Projektör HESAP KÖKÜNE bağlıdır ve o kök açılışta SONRADAN pinlenir
// (`bindAccountRoot`) — bu yüzden nesne LAZY kurulur ve kök değişince yeniden
// doğar. Kök yoksa `null` döner: "hesap bağlı değil" ile "özellik kapalı" iki
// ayrı hâldir ve karıştırılmaz.
let _prefsProjector = null;
let _prefsProjectorRoot = null;

function prefsProjector() {
  const root = (boundAccount && boundAccount.root) || null;
  if (!root) { _prefsProjector = null; _prefsProjectorRoot = null; return null; }
  if (_prefsProjector && _prefsProjectorRoot === root) return _prefsProjector;
  try {
    _prefsProjector = prefsProjectorFactory.createPrefsProjector({
      dir: root,
      deviceId: (boundAccount && boundAccount.deviceId) || null,
      readSettings: () => agentSettings.readSettings(),
      writeSettings: (patch) => agentSettings.writeSettings(patch),
      // İKİ KAPI: bulut senkronu kapalıysa projeksiyon üretmenin bir alıcısı yok;
      // `prefsSyncEnabled` ise özelliğin KENDİ geri alma koludur.
      getEnabled: () => {
        const st = agentSettings.readSettings();
        return st.cloudSyncEnabled === true && st.prefsSyncEnabled !== false;
      },
      log: (l) => logLine(l),
    });
    _prefsProjectorRoot = root;
  } catch (err) {
    logLine(`[prefs] projektör kurulamadı: ${err.message}`);
    _prefsProjector = null;
    _prefsProjectorRoot = null;
  }
  return _prefsProjector;
}

/** Yerel ayar değişti → projeksiyonu tazele (senkron izleyicisi gerisini yapar). */
function prefsProjectNow(reason) {
  const p = prefsProjector();
  if (!p) return;
  try {
    const r = p.projectSettings();
    if (r && r.ok && r.changed && r.changed.length) {
      logLine(`[prefs] projeksiyon güncellendi (${reason}): ${r.changed.join(', ')}`);
    }
  } catch (err) { logLine(`[prefs] projeksiyon hatası: ${err.message}`); }
}

/**
 * Uzak doküman diske indi → beyaz listeli anahtarları YEREL DURUMA uygula ve
 * renderer'a haber ver.
 *
 * ⚠️ `transformIncoming` yazımdan ÖNCE koşar; uygulama yazımdan SONRA olmak
 * zorunda. Bu yüzden kanca yalnız İŞARET koyar, iş `setImmediate` ile bir sonraki
 * tur'a bırakılır (motor o ana kadar `applyBytes`i bitirmiş olur).
 */
let _prefsApplyQueued = false;
function prefsApplySoon() {
  if (_prefsApplyQueued) return;
  _prefsApplyQueued = true;
  setImmediate(() => {
    _prefsApplyQueued = false;
    const p = prefsProjector();
    if (!p) return;
    let applied = [];
    try {
      const r = p.applyToSettings();
      applied = (r && r.applied) || [];
    } catch (err) { logLine(`[prefs] uygulama hatası: ${err.message}`); return; }
    // Dil değiştiyse ADP-888'in üç tüketicisi de tazelenir (main diyalogları +
    // açık pencereler + bundan sonra doğacaklar) — restart GEREKMEZ.
    if (applied.includes('locale')) { try { broadcastLocale(); } catch { /* dil yayını kritik değil */ } }
    // Renderer YALNIZ "değişti" sinyalini alır; değerleri `prefs:pull` ile çeker
    // (ADP-712 deseni: gövde IPC'de dolaşmaz).
    try {
      const payload = { applied, at: new Date().toISOString() };
      if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('prefs:changed', payload);
      for (const w of popoutWindows.values()) {
        if (w && !w.isDestroyed()) w.webContents.send('prefs:changed', payload);
      }
    } catch { /* pencere kapanmış olabilir */ }
  });
}

const syncRuntime = syncBoot.createSyncRuntime({
  getEnabled: () => agentSettings.readSettings().cloudSyncEnabled === true,
  getRoots: () => ({
    workspaceRoot: agentWorkspaceRoot || null,
    accountRoot: (boundAccount && boundAccount.root) || null,
  }),
  getTarget: () => {
    const env = publicSupabaseEnv();
    // SYNC-CLOUD-01 — HEDEF ÜÇ PARÇADIR, İKİ DEĞİL. `{url,key}` ile yetinmek
    // BUG-R2'nin ölçtüğü arızanın ta kendisiydi: bulut projede tablolar `app`
    // şemasındadır ve satırlar `company_id` ile kiracıya bağlıdır.
    //   • schema eksikse    → PostgREST `public`e bakar (PGRST205, hiçbir şey gitmez)
    //   • companyId eksikse → istemci `company_id=is.null` süzer; satırlar (trigger
    //     doldurduğu için) DOLU gelir ⇒ okuma HER ZAMAN 0 satır, ikinci cihaz boş kalır
    // İkisi de ADP-621/ADP-703'ün zaten çözdüğü değerler; burada yalnız İLETİLİR.
    let companyId = null;
    try {
      const meta = (boundAccount && boundAccount.root) ? accountScope.readAccountMeta(boundAccount.root) : null;
      companyId = (meta && typeof meta.companyId === 'string' && meta.companyId.trim()) ? meta.companyId.trim() : null;
    } catch { companyId = null; }
    return {
      url: env.NEXT_PUBLIC_CREWPANE_SUPABASE_URL,
      key: env.NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY,
      schema: env.NEXT_PUBLIC_CREWPANE_SUPABASE_SCHEMA || null,
      companyId,
    };
  },
  getPlanSnapshot: () => (seatGate ? seatGate.state() : null),
  getDeviceId: () => (boundAccount && boundAccount.deviceId) || null,
  // Jeton ASENKRON çözülür, istemci SENKRON okur (syncBoot kutu deseni).
  getToken: () => appDbTokenFor('sync:cloud'),
  deriveIndexes: memoryIndexDerive.createDeriveIndexesHook({
    roots: () => ({
      workspaceRoot: agentWorkspaceRoot || null,
      accountRoot: (boundAccount && boundAccount.root) || null,
    }),
    // İNDİRİLEN dosyadan sonra indeks GERÇEKTEN yazılır — gölge faz değil.
    write: true,
    log: (l) => logLine(l),
  }),
  // SYNC-F1-7 — gelen tercih dokümanı DİSKE YAZILMADAN ÖNCE anahtar bazında
  // birleşir; yazımdan sonra uygulanır. Kanca yalnız `prefs` sınıfına bakar:
  // hafıza/skill dosyaları BİT-BİT eskisi gibi taşınır.
  transformIncoming: ({ class: cls, buf }) => {
    if (cls !== 'prefs') return null;
    const p = prefsProjector();
    if (!p) return null;
    const merged = p.mergeIncoming(buf);
    prefsApplySoon();
    return merged;
  },
  // Ret SESSİZ kalmaz: aynı `plan:limit` kanalı, yükseltme kartı BL-03'teki tek yerde.
  onPlanDenied: (denial) => pushPlanLimit(denial),
  log: (l) => logLine(l),
});
const syncIpcSurface = syncSurface.createSyncIpc({
  getEngine: () => syncRuntime.getEngine(),
  getSetup: () => syncRuntime.describe(),
  log: (l) => logLine(l),
});

/** Tercih/kök/hedef değişti → motoru yeniden çöz (kapanışta ANINDA söker). */
// ── SYNC-F1-7 — TERCİH IPC'Sİ (renderer ekseni: localStorage) ────────────────
//
// Renderer'ın `localStorage`ı main'den OKUNAMAZ; bu yüzden düzen/sekme tercihleri
// iki yönlü bir IPC ile taşınır. Sınır DAR: renderer yalnız KENDİ eksenindeki
// (beyaz listede `renderer` kaynaklı) anahtarları yazabilir — `publishRenderer`
// gerisini düşürür, yani bir XSS yüzeyi buradan `locale`ı ya da bir sırrı
// projeksiyona sokamaz.
ipcMain.handle('prefs:publish', (_e, input) => {
  const p = prefsProjector();
  if (!p) return { ok: false, reason: 'no-account' };
  const map = input && typeof input === 'object' && !Array.isArray(input.values) ? input.values : null;
  if (!map || typeof map !== 'object') return { ok: false, reason: 'bad-input' };
  try { return p.publishRenderer(map); }
  catch (err) { logLine(`[prefs] renderer yayını hatası: ${err.message}`); return { ok: false, reason: 'error' }; }
});
/** Doküman → renderer'ın uygulaması gereken `localStorage` değerleri + durum. */
ipcMain.handle('prefs:pull', () => {
  const p = prefsProjector();
  if (!p) return { ok: false, reason: 'no-account', values: {}, keys: prefsWhitelist.RENDERER_KEYS };
  try { return { ok: true, values: p.rendererValues(), keys: prefsWhitelist.RENDERER_KEYS, status: p.status() }; }
  catch (err) { logLine(`[prefs] renderer çekimi hatası: ${err.message}`); return { ok: false, reason: 'error', values: {}, keys: prefsWhitelist.RENDERER_KEYS }; }
});
/** Ayarlar → Senkron satırının GERÇEĞİ (tahmin değil: dosya + anahtar sayısı + son uygulama). */
ipcMain.handle('prefs:status', () => {
  const p = prefsProjector();
  if (!p) return { ok: false, reason: 'no-account' };
  try { return { ok: true, ...p.status() }; }
  catch { return { ok: false, reason: 'error' }; }
});

// VOICE-TRUNC-02 — AgentVoice dikte teslimi: köprüden TEK parça gelen metni ODAKLI
// penceredeki odaklı yüzeye (okunabilir kutu / xterm) `webContents.insertText` ile
// indirir. Karar/doğrulama çekirdeği dictationDelivery.cjs'te (IO enjekte, birim
// testli); burası yalnız gerçek pencere + webContents'i bağlar.
const dictationDelivery = require('./src/voice/dictationDelivery.cjs');
async function deliverDictationToFocusedSurface(text) {
  // Odak hangi penceredeyse oraya: popout pane ayrı bir BrowserWindow'dur; dikte
  // sırasında CrewPane öndedir, yani odaklı pencere doğru hedeftir. Hiçbir
  // pencere odaklı değilse ana pencereye düşülür (odak sondası yine de yüzey
  // bulamazsa teslim REDDEDİLİR — sessizce yanlış yere yazılmaz).
  const win = BrowserWindow.getFocusedWindow() || appWindow;
  if (!win || win.isDestroyed()) return { ok: false, error: 'no app window' };
  const wc = win.webContents;
  const res = await dictationDelivery.deliverDictation(text, {
    probe: () => wc.executeJavaScript(dictationDelivery.FOCUS_PROBE_JS),
    insertText: async (t) => { wc.insertText(t); },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: logLine,
  });
  // TOUR-02-A — günlük maddesi 8 "Sesle bir iş ver". Bu OLGU yalnız main'de
  // bilinir (dikte köprüsü bir HTTP ucudur, renderer'ın haberi olmaz) ve
  // renderer'da başka hiçbir izi yoktur: yazılan metin `insertText` ile gelir,
  // yani kullanıcının kendi yazmasından AYIRT EDİLEMEZ. Bu yüzden teslim
  // BAŞARILIYSA sayfaya damgasız bir DOM olayı atılır. 🔴 METİN GİTMEZ — olay
  // gövdesi BOŞ; sayfanın öğrendiği tek şey "bir dikte teslim edildi".
  if (res && res.ok) {
    try {
      wc.executeJavaScript(
        "window.dispatchEvent(new CustomEvent('crewpane:dictation-delivered'))",
      ).catch(() => {});
    } catch { /* ölçüm asla teslimi düşürmez */ }
  }
  return res;
}

// ── TC-01 — TAKIM KURUCU (ADR-TEAM-COMPOSER §4-§5, §9) ───────────────────────
// Sözleşme: docs/design/TEAM-COMPOSER-R1/IPC-CONTRACT.md
//
// KARAR BURADA: rol süzgeci + tavanlar + onay jetonu + geri alma günlüğü. Köprü
// yalnız taşır (`/team/compose`), renderer yalnız SATIRI kurar ve YAZAR
// (installPreset). Bu dosya HİÇBİR modele istek atmaz (§9.2).
//
// 🔴 Defter BELLEKTE: geri alma "o koşuda yazılanı geri almak"tır, genel bir çöp
// kutusu değil — uygulama kapanınca pencere kapanır (ADR §4.4).
let composeLedger = null;
function ensureComposeLedger() {
  if (!composeLedger) composeLedger = teamComposeCore.createComposeLedger();
  return composeLedger;
}

/** §9.7 — kullanıcının seçtiği özerklik kademesi (okunamazsa EN DAR kademe). */
function composeAutonomy() {
  try {
    return agentSettings.sanitizeTeamCompose(agentSettings.readSettings().teamCompose).autonomy;
  } catch {
    return teamComposeCore.DEFAULT_AUTONOMY;
  }
}

/**
 * ADR §5 + §9.6 — PLAN CÜMLESİ (bilgi, ret değil).
 *
 * Satır yazmak bir plan kapısı DEĞİLDİR; kapı EŞZAMANLI AJAN tavanıdır
 * (`planDenial('agents', ptys.size)`). Kart kullanıcıya bunu ÖNCEDEN söyler:
 * "kuracaksın ama aynı anda kaçı koşar". `notify:false` — bu bir ret değil,
 * ekrana plan kartı BASILMAZ.
 *
 * Cümle `planLimits.cjs`ten gelir; burada metin YAZILMAZ ve tutar/fiyat GEÇMEZ.
 */
function composePlanNote(seatCount) {
  try {
    const snapshot = seatGate ? seatGate.state() : null;
    const wanted = ptys.size + Math.max(0, Number(seatCount) || 0);
    const decision = planLimits.decide({ snapshot, feature: 'agents', current: wanted });
    return decision.allowed ? null : decision.message || null;
  } catch {
    return null; // plan bilgisi ÖNERİYİ DÜŞÜRMEZ (fail-open: bilgi eksik kalır, iş durmaz)
  }
}

/** Köprü cevabını tek yerden kur (durum kodu sözlüğü IPC-CONTRACT §2). */
function composeFail(status, code, error, extra = {}) {
  return { status, body: { ok: false, code, error, ...extra } };
}

/**
 * Köprünün IPC turu (`callRenderer`). Kullanıcının şeritten başlattığı geri alma
 * da bunu kullanır — bkz. `team-compose:undo-request`.
 */
let composeTransport = null;
/** TC-FIX-01 — lidere kurulum notu: meşgulse bu aralıkla, bu bütçe kadar yeniden dene. */
const COMPOSE_NOTIFY_RETRY_MS = 3000;
const COMPOSE_NOTIFY_BUDGET_MS = 120_000;

/**
 * `/team/compose` — propose · apply · undo.
 *
 * @param {object} req köprünün doğruladığı gövde (validateComposePayload)
 * @param {{callRenderer:Function}} transport köprünün IPC turu (ikinci bir
 *   correlation defteri açmamak için AÇIKÇA geçirilir)
 */
async function teamComposeRequest(req, transport) {
  const ledger = ensureComposeLedger();
  const callRenderer = transport && transport.callRenderer;
  if (typeof callRenderer !== 'function') return composeFail(501, 'no-transport', 'renderer köprüsü yok.');

  // ── propose — YAN ETKİSİZ (ADR §4.1) ───────────────────────────────────────
  if (req.action === 'propose') {
    const autonomy = composeAutonomy();
    const mode = teamComposeCore.normalizeMode(req.mode);
    // Satırları RENDERER kurar: rol kataloğu, şablon eşleştirici ve ad havuzu
    // orada yaşayan TS leaf modülleridir. Main'de ikinci bir katalog tutmak
    // ADR §7'nin reddettiği "ikinci kopya"dır.
    // TC-07 — mode:'engine': hedef motor ÜRÜNÜN SUNDUĞU bir motor olmalı (ENG-21 hükmü:
    // kapalı raf / tanınmayan id → red, pane açılışta ölmesin). Karar burada, renderer
    // yalnız satırları kurar.
    let engineLabel = '';
    if (mode === 'engine') {
      const engineId = String(req.engine || '').trim().toLowerCase();
      if (!engineId || !engineOffering.isOffered(engineId)) {
        return composeFail(422, 'empty', engineId ? `"${engineId}" bu üründe sunulan bir motor değil.` : 'engine alanı zorunlu.', {
          reason: 'no-such-engine',
          howTo: 'engine alanına ürünün sunduğu bir motor id\'si yaz: claude, codex, copilot, goose, gemini, qwen, opencode, cursor, kimi, crush, antigravity.',
        });
      }
      const d = engineRegistry.getEngine(engineId);
      engineLabel = (d && d.label) || engineId;
    }
    let built;
    try {
      built = await callRenderer('team-compose:propose', {
        objective: req.objective,
        roles: Array.isArray(req.roles) ? req.roles : [],
        mode,
        teamName: req.teamName || '',
        department: req.department,
        leaderId: req.leaderId,
        maxEmployees: ledger.caps.maxEmployees,
        // §4.1-3 — bu oturumda reddedilen roller bir daha SORULMAZ.
        rejectedRoles: ledger.rejectedRoles(),
        // TC-07 — mode:'engine' girdileri (renderer mevcut çalışanlardan satır kurar).
        engine: req.engine || '',
        engineLabel,
        agents: Array.isArray(req.agents) ? req.agents : [],
      });
    } catch (err) {
      return composeFail(504, 'renderer-timeout', String((err && err.message) || err));
    }
    if (!built || !built.ok) {
      return composeFail(502, 'renderer', (built && built.error) || 'öneri üretilemedi.');
    }
    // Renderer'ın döndürdüğü satırlar da SÜZGEÇTEN geçer: kararın tek sahibi main.
    // (Kullanıcı düzenlemesi de aynı süzgece girer — IPC-CONTRACT §4.1.)
    const allowed = Array.isArray(built.catalogSlugs) ? built.catalogSlugs : [];
    const { rows, dropped } = teamComposeCore.sanitizeRows(built.rows, allowed);
    if (dropped.length) logLine(`team compose: katalog dışı ${dropped.length} satır düştü (${dropped.join(',')})`);
    // §9.5 — MODEL ETİKETİNİN SON SÖZÜ MAIN'DE.
    //
    // 🪤 ÖLÇÜLDÜ (TC-01 e2e): renderer'ın gördüğü katalog (`modelCatalog.cjs`)
    // claude satırlarını ALIAS'la taşır ('opus', 'fable') — liderin kaydındaki TAM
    // id ('claude-fable-5-1') o listede YOKTUR, etiket boş döner ve kartta ham id
    // görünürdü. `labelForModelId` ürünün BU işi yapan tek fonksiyonudur (ikinci
    // bir çevirici YAZILMAZ); renderer'a taşımak fs/os bağımlılığını renderer'a
    // sokardı, o yüzden çeviri zincirin main ucunda yapılır.
    // SIRA ÖNEMLİ: önce MOTORUN KENDİ katalog etiketi (codex "GPT-6 Astra",
    // antigravity "Gemini 3.8 Flash" — kaynağın kendi yazımı), yoksa
    // `labelForModelId`. Ters sırada, tanımadığı bir id'yi "kısaltılmış ham id"
    // olarak döndüren `labelForModelId` iyi katalog etiketini EZERDİ (ölçüldü:
    // gemini-3.8-flash → "gemini-3.8-flash").
    for (const r of rows) {
      // 🪤 `sanitizeRow` etiket bulamayınca HAM İD'e düşer — o hâl bir etiket
      // DEĞİLDİR ve burada katalog etiketi sayılmamalıdır (ölçüldü: kartta
      // "claude-fable-5-1" göründü). Ayırt edici işaret: etiket id'nin AYNISI mı?
      const catalogLabel = r.modelLabel && r.modelLabel !== r.model ? r.modelLabel : '';
      r.modelLabel = teamComposeCore.composeModelLabel(
        r.engine,
        r.model,
        catalogLabel || modelDetect.labelForModelId(r.model) || '',
      );
    }
    // TC-07 — renderer'ın düşme SAYIMI ('dropped': dolu koltuk / katalog dışı /
    // reddedilmiş / bilinmeyen ajan) karara girer: "satır kalmadı" reddi artık
    // NEDENİYLE ve "nasıl doğru çağırırım" bilgisiyle döner. 20.09'daki üç 422'nin
    // gerçek nedeni "koltuk zaten dolu" idi, cümle "rol listesinde yok" diyordu.
    const cap = teamComposeCore.capDecision({
      rows,
      mode,
      sessionInstalls: ledger.sessionInstalls(),
      dropped: built.dropped && typeof built.dropped === 'object' ? built.dropped : null,
      allowedSlugs: allowed,
    });
    if (!cap.ok) {
      // 'empty' = süzgeçten sonra rol kalmadı → kart AÇILMAZ (§9.2 kabul koşulu).
      if (cap.code === 'empty') {
        logLine(`team compose: öneri üretilmedi reason=${cap.reason} existing=${(cap.existing || []).join(',')} unmatched=${(cap.unmatched || []).join(',')}`);
        return composeFail(422, cap.code, cap.error || cap.reason, {
          cap: cap.cap,
          reason: cap.reason,
          howTo: cap.howTo,
          existing: cap.existing,
          unmatched: cap.unmatched,
          rejected: cap.rejected,
          unknownAgents: cap.unknownAgents,
          nearest: cap.nearest,
        });
      }
      return composeFail(429, cap.code, cap.reason, { cap: cap.cap });
    }
    // TC-07 — mode:'engine' YENİ ajan açmaz: "aynı anda kaçı koşar" notu burada anlamsız.
    const planNote = mode === 'engine' ? null : composePlanNote(rows.length);
    const proposal = ledger.putProposal({
      leaderId: req.leaderId,
      department: req.department,
      mode,
      // TC-05 (TC-04 BULGU-1) — patronun cümlesi buraya kadar geliyordu ama DEFTERE
      // girmiyordu; kart onu hiç göremiyordu. Onay kartında gösterilecek TEK bağlam bu.
      objective: req.objective,
      teamName: built.teamName || req.teamName || '',
      rows,
      targetTeamId: built.targetTeamId || null,
      planNote,
      source: req.source,
      autonomy,
      // TC-07 — mode:'engine': hedef motor + etiketi (kart başlığı ve makbuz bunu yazar).
      engine: mode === 'engine' ? String(req.engine || '').toLowerCase() : '',
      engineLabel: mode === 'engine' ? engineLabel : '',
    });
    // Kartı göster (TC-02 bu olayı dinler). Otomatik kademede de gönderilir:
    // kart açılmasa bile ofis yüzeyi ne olduğunu bilir.
    try {
      if (appWindow && !appWindow.isDestroyed()) {
        appWindow.webContents.send('team-compose:proposal', {
          proposalId: proposal.proposalId,
          mode: proposal.mode,
          // TC-05 — IPC-CONTRACT §3.2'nin alanı. Kart bunu tırnak içinde çizer.
          objective: proposal.objective,
          teamName: proposal.teamName,
          rows: proposal.rows,
          expiresAt: new Date(proposal.expiresAtMs).toISOString(),
          planNote: proposal.planNote,
          source: proposal.source,
          autonomy: proposal.autonomy,
          // TC-07 — kart "Dara'yı Codex ile çalıştır" başlığını bundan kurar.
          engine: proposal.engine,
          engineLabel: proposal.engineLabel,
        });
      }
    } catch (err) {
      logLine(`team compose: kart gönderilemedi (${err.message})`);
    }
    return {
      status: 200,
      body: {
        ok: true,
        proposalId: proposal.proposalId,
        mode: proposal.mode,
        engine: proposal.engine,
        engineLabel: proposal.engineLabel,
        status: proposal.approval ? 'approved' : 'awaiting-approval',
        // §9.7 — jeton YALNIZ ayar kademesi ürettiğinde lidere döner. 'ask'ta
        // jeton kullanıcının tıklamasıyla doğar ve lider onu UYDURAMAZ.
        ...(proposal.approval ? { approvalToken: proposal.approval.token } : {}),
        teamName: proposal.teamName,
        rows: proposal.rows,
        planNote: proposal.planNote,
        expiresAt: new Date(proposal.expiresAtMs).toISOString(),
      },
    };
  }

  // ── apply — YALNIZ MAIN'İN ÜRETTİĞİ JETONLA (ADR §4.2-4.3) ─────────────────
  if (req.action === 'apply') {
    const taken = ledger.takeApproval(req.proposalId, req.approvalToken);
    if (!taken.ok) {
      // TC-FIX-01 — ürün onay tıklamasında apply'ı KENDİSİ koşturur; lider eski
      // alışkanlıkla apply çağırırsa öneri defterden düşmüştür ('unknown'). Bu
      // "süresi dolmuş" DEĞİL "zaten kuruldu"dur: aynı makbuz döner (idempotent),
      // lider doğru cümleyi kurar. Verilen jeton yine eşleşmek zorunda.
      if (taken.code === 'unknown') {
        const done = ledger.peekUndo(req.proposalId);
        if (done) {
          const given = String(req.approvalToken || '').trim();
          if (given && done.approvalToken && given !== done.approvalToken) {
            return composeFail(409, 'bad-token', 'Onay jetonu geçersiz.');
          }
          return {
            status: 200,
            body: {
              ok: true,
              alreadyApplied: true,
              proposalId: done.proposalId,
              teamId: done.teamId,
              teamName: done.teamName,
              wingSlug: done.wingSlug,
              employees: done.employeeIds.length,
              names: done.names,
              receipt: done.receipt,
              // Araç metni MAIN'de kurulur (MCP süreci teamCompose.cjs'i require ETMEZ:
              // asarUnpack listesine ikinci bir modül sokmamak için — tek kaynak burada).
              receiptText: teamComposeCore.composeReceiptText({
                teamName: done.teamName,
                receipt: done.receipt,
                alreadyApplied: true,
                // TC-07 — motor değişikliği de idempotent: "zaten değiştirildi".
                mode: done.mode,
                engine: done.engine,
                engineLabel: done.engineLabel,
                engineChanges: done.engineChanges,
              }),
              unresolvedRoles: [],
              renamed: [],
              undoExpiresAt: new Date(done.expiresAtMs).toISOString(),
            },
          };
        }
      }
      // Onay yoksa kartı YENİDEN göster (ADR §4.2) — lider duvara toslamasın,
      // kullanıcı kararını versin.
      if (taken.code === 'awaiting-approval' && taken.proposal) {
        try {
          if (appWindow && !appWindow.isDestroyed()) {
            appWindow.webContents.send('team-compose:proposal', {
              proposalId: taken.proposal.proposalId,
              mode: taken.proposal.mode,
              // TC-05 — YENİDEN gösterimde de aynı yük: kart iki kez açıldığında
              // patron hangi öneriye baktığını yine cümlesinden ayırt eder.
              objective: taken.proposal.objective,
              teamName: taken.proposal.teamName,
              rows: taken.proposal.rows,
              expiresAt: new Date(taken.proposal.expiresAtMs).toISOString(),
              planNote: taken.proposal.planNote,
              source: taken.proposal.source,
              autonomy: taken.proposal.autonomy,
              engine: taken.proposal.engine,
              engineLabel: taken.proposal.engineLabel,
            });
          }
        } catch { /* kartı yeniden göstermek best-effort */ }
      }
      return composeFail(taken.code === 'unknown' ? 410 : 409, taken.code, taken.reason);
    }
    const p = taken.proposal;
    // ── TC-07 — mode:'engine': satır YAZILMAZ, `employees.engine` DEĞİŞİR ──────
    // Ayrı dal: kurulum makbuzu (sekme/masa ölçümü), izin yazımı ve "Ekip kuruldu"
    // cümlesi bu yolda ANLAMSIZ. Renderer `updateEmployee` ile motoru yazar ve eski
    // değerleri döner; undo o değerlere döner. Açık pane HATA-12 şeridini kendisi çizer.
    if (p.mode === 'engine') return applyEngineProposal(p, req, ledger, callRenderer);
    let applied;
    try {
      applied = await callRenderer(
        'team-compose:apply',
        {
          proposalId: p.proposalId,
          mode: p.mode,
          teamName: p.teamName,
          rows: p.rows,
          targetTeamId: p.targetTeamId,
        },
        // Kurulum N satır yazar (her biri agents + employees insert'i); 15 sn'lik
        // varsayılan IPC bütçesi 6 koltukta yetmeyebilir → 60 sn.
        60_000,
      );
    } catch (err) {
      // TC-FIX-01 — tur hiç dönmedi: hiçbir satır yazılmadığı bilinemez ama jeton
      // kilitli kalırsa patronun onayı ÇÖPE gider. Geri açılır; yarım yazım riski
      // undo günlüğünde değil, renderer'ın kendi kısmi-yazım cevabındadır.
      ledger.releaseApproval(p.proposalId);
      return composeFail(504, 'renderer-timeout', String((err && err.message) || err));
    }
    if (!applied || !applied.ok) {
      // Hiç satır yazılmadıysa onay geçerli kalır (yeniden denenebilir); KISMİ yazımda
      // jeton harcanmış sayılır — aynı kadroyu ikinci kez kurmak daha kötü olurdu.
      const wroteAny = applied && Array.isArray(applied.employeeIds) && applied.employeeIds.length > 0;
      if (!wroteAny) ledger.releaseApproval(p.proposalId);
      return composeFail(502, 'renderer', (applied && applied.error) || 'ekip kurulamadı.');
    }
    // ── TC-05 (TC-04 BULGU-2) — LİDER KENDİ KURDURDUĞU KADROYA İŞ VEREBİLMELİ ──
    //
    // ÖLÇÜLEN KUSUR: `mode:'team'` YENİ bir takım açar (yeni wing slug). Liderin
    // kapsamı kendi takımıdır → `teamScope.authorize`ın 1. kuralı (EŞİTLİK) yeni takımı
    // her zaman kapsam DIŞI sayar. Sonuç: patron onay kartında kadroyu onaylıyor, lider
    // hemen ardından iş vermeye kalkınca "bu senin takımın değil, sahibin izin vermeli"
    // uyarısıyla İKİNCİ bir izin kartı çıkıyordu (ADR §8: "aynı oturumda delege edebilir").
    //
    // KARAR (kart §Karar, seçenek a): kural DOĞRU, düzeltme kuralda DEĞİL. Patron zaten
    // bu kadroyu onayladı; onayın anlamı "bu insanlar bu liderin emrinde çalışacak"tır.
    // O yüzden apply başarılı olduğunda izin ÜRÜN tarafından yazılır — Ayarlar → Takım
    // İzinleri'ndeki "Her zaman izin ver"in yazdığı AYNI kayıt (`mode:'always'` =
    // delegate + manage), yalnız `origin:'system'` damgasıyla.
    //
    // ÜÇ SINIR (hepsi kasıtlı):
    //   • YALNIZ BU APPLY'IN AÇTIĞI TAKIM (`createdTeam === true`). Var olan bir takıma
    //     koltuk eklemek (`mode:'role'`) o takımın YÖNETİMİNİ devretmez.
    //   • Liderin KENDİ takımıysa hiçbir şey yazılmaz — zaten `own-scope` geçiyor.
    //   • `origin:'system'` → geri alma yalnız BUNU siler; sahibin kendi eliyle verdiği
    //     izne hiçbir akış dokunmaz (teamScope.revokeGrant).
    const appliedWing = teamScope.normalizeScope(applied.wingSlug || '');
    const leaderOwnScope = teamScope.normalizeScope(callerScopeFor(req.leaderId, req.department));
    const autoScope =
      applied.createdTeam === true && appliedWing && appliedWing !== leaderOwnScope ? appliedWing : null;
    // İzin ÖNCE yazılır: makbuzun `leaderCanDelegate` alanı bir iddia değil, yazımın
    // sonucudur (yazılamadıysa false — lider ilk delegasyonda izin kartı görür).
    let leaderCanDelegate = !!appliedWing && appliedWing === leaderOwnScope;
    if (autoScope) {
      try {
        const granted = agentSettings.grantTeamScope({
          leaderId: p.leaderId,
          scopes: [autoScope],
          mode: 'always',
          origin: 'system',
        });
        leaderCanDelegate = granted && granted.ok === true;
        logLine(
          `team compose: kurulan takım için lidere izin YAZILDI (leader=${p.leaderId} scope=${autoScope} ok=${granted.ok})`,
        );
      } catch (err) {
        // İzin yazılamadıysa KURULUM GEÇERLİDİR — lider yalnız eski davranışa düşer
        // (ilk delegasyonda izin kartı çıkar). Kurulumu geri almak daha kötü olurdu.
        logLine(`team compose: izin yazılamadı (${String((err && err.message) || err)})`);
      }
    }
    // TC-FIX-01 §6 — MAKBUZ. `visible` RENDERER'IN ÖLÇÜMÜDÜR (sekme çizildi mi, seçili
    // mi, şeride sığdı mı, kaç masa): ölçüm gelmediyse `pending` — makbuz yalan söylemez,
    // lider "ofiste, masalarında"yı ancak `seen`de kurar.
    const undoUntilIso = new Date(Date.now() + teamComposeCore.UNDO_TTL_MS).toISOString();
    const receipt = teamComposeCore.buildReceipt({
      createdTeam: applied.createdTeam === true,
      employees: Array.isArray(applied.employeeIds) ? applied.employeeIds.length : 0,
      names: Array.isArray(applied.names) ? applied.names : [],
      wingSlug: applied.wingSlug || null,
      visible: applied.visible,
      leaderCanDelegate,
      undoUntil: undoUntilIso,
    });
    const entry = ledger.recordApplied(p.proposalId, {
      teamId: applied.teamId || null,
      createdTeam: applied.createdTeam === true,
      employeeIds: Array.isArray(applied.employeeIds) ? applied.employeeIds : [],
      names: Array.isArray(applied.names) ? applied.names : [],
      wingSlug: applied.wingSlug || null,
      teamName: p.teamName,
      leaderId: p.leaderId,
      scopeGrant: autoScope,
      receipt,
    });
    receipt.undoUntil = new Date(entry.expiresAtMs).toISOString();
    // §9.6 — "10 dakika içinde geri al" cümlesi YALNIZ kurulum SONRASI şeritte.
    // TC-FIX-01 — şerit `wingSlug` + `teamName` + `visible`ı da alır: "N kişi '<Takım>'
    // sekmesinde masasına oturdu · Sekmeye git" (eskiden renderer wingSlug'ı düşürüyordu).
    try {
      if (appWindow && !appWindow.isDestroyed()) {
        appWindow.webContents.send('team-compose:applied', {
          proposalId: entry.proposalId,
          teamName: entry.teamName,
          names: entry.names,
          wingSlug: entry.wingSlug,
          visible: receipt.visible,
          undoExpiresAt: new Date(entry.expiresAtMs).toISOString(),
        });
      }
    } catch { /* şerit best-effort — kurulum GERÇEKLEŞTİ */ }
    logLine(
      `team compose APPLY → team=${entry.teamId || '?'} employees=${entry.employeeIds.length} ` +
        `createdTeam=${entry.createdTeam} leader=${req.leaderId}`,
    );
    return {
      status: 200,
      body: {
        ok: true,
        proposalId: entry.proposalId,
        teamId: entry.teamId,
        teamName: entry.teamName,
        // Ofis sekmesinin kimliği — TC-02 şeridi ve kabul e2e'si "ofiste belirdi mi"yi
        // BUNDAN ölçer (takım adı ekranda kısaltılıp büyütülür, slug değişmez).
        wingSlug: entry.wingSlug,
        employees: entry.employeeIds.length,
        names: entry.names,
        // TC-FIX-01 §6 — araç metni ve pane notu BUNDAN türer (composeReceiptText).
        receipt,
        receiptText: teamComposeCore.composeReceiptText({ teamName: entry.teamName, receipt }),
        unresolvedRoles: Array.isArray(applied.unresolvedRoles) ? applied.unresolvedRoles : [],
        renamed: Array.isArray(applied.renamed) ? applied.renamed : [],
        undoExpiresAt: new Date(entry.expiresAtMs).toISOString(),
      },
    };
  }

  // ── undo — YAZDIĞIMIZ HER SATIR (ADR §4.4) ─────────────────────────────────
  const entry = ledger.takeUndo(req.proposalId);
  if (!entry) {
    return composeFail(
      409,
      'undo-window-closed',
      'Geri alma süresi doldu ya da bu kurulum zaten geri alındı (pencere 10 dakika).',
    );
  }
  let undone;
  try {
    undone = await callRenderer(
      'team-compose:undo',
      {
        teamId: entry.teamId,
        // 🔴 mode:'role'da takım BİZİM açtığımız DEĞİLDİR → SİLİNMEZ.
        createdTeam: entry.createdTeam,
        // 🔴 TC-07 mode:'engine'de HİÇBİR satır silinmez: employeeIds BOŞ gider,
        // `engineChanges` eski motor/model/eforu geri yazdırır.
        employeeIds: entry.mode === 'engine' ? [] : entry.employeeIds,
        mode: entry.mode,
        engineChanges: entry.mode === 'engine' ? entry.engineChanges : [],
      },
      60_000,
    );
  } catch (err) {
    return composeFail(504, 'renderer-timeout', String((err && err.message) || err));
  }
  if (!undone || !undone.ok) {
    return composeFail(502, 'renderer', (undone && undone.error) || 'geri alınamadı.');
  }
  if (entry.mode === 'engine') {
    logLine(`team compose UNDO (engine) → restored=${undone.restoredEngines || 0} leader=${entry.leaderId}`);
    return {
      status: 200,
      body: { ok: true, removedEmployees: 0, removedTeam: false, restoredEngines: undone.restoredEngines || 0 },
    };
  }
  // TC-05 — geri alma SADECE satır silmez: apply'ın yazdığı izni de geri alır. Takım
  // artık yoksa lider o takım üzerinde yetki taşımaya devam etmemeli (izin listesinde
  // ölü bir satır kalırdı). Kimlik DEFTERDEN okunur; undo'yu çağıran başkası olabilir.
  if (entry.scopeGrant && entry.leaderId) {
    try {
      const revoked = agentSettings.revokeTeamScope({
        leaderId: entry.leaderId,
        scope: entry.scopeGrant,
        origin: 'system',
      });
      logLine(
        `team compose: geri alma izni de sildi (leader=${entry.leaderId} scope=${entry.scopeGrant} ok=${revoked.ok})`,
      );
    } catch (err) {
      logLine(`team compose: izin silinemedi (${String((err && err.message) || err)})`);
    }
  }
  logLine(
    `team compose UNDO → employees=${undone.removedEmployees || 0} team=${undone.removedTeam ? 'silindi' : 'korundu'}`,
  );
  return {
    status: 200,
    body: {
      ok: true,
      removedEmployees: undone.removedEmployees || 0,
      removedTeam: undone.removedTeam === true,
    },
  };
}

/**
 * TC-07 — mode:'engine' apply. Satır yazmaz; renderer `updateEmployee` ile motoru
 * yazar (model/efor sıfırlanır → "motorun kendi varsayılanı", kart satırında
 * seçildiyse o yazılır). Eski değerler `engineChanges`te deftere geçer (undo).
 * `paneOpen` MAIN'İN ÖLÇÜMÜDÜR (canlı pty defteri): şerit ancak açık pane'de çizilir,
 * makbuz "yeni motorla koşuyor" DEMEZ.
 */
async function applyEngineProposal(p, req, ledger, callRenderer) {
  const rows = (Array.isArray(p.rows) ? p.rows : []).filter((r) => r && r.employeeId);
  if (!rows.length) {
    ledger.releaseApproval(p.proposalId);
    return composeFail(502, 'renderer', 'motoru değiştirilecek kimse yok.');
  }
  let applied;
  try {
    applied = await callRenderer(
      'team-compose:apply',
      { proposalId: p.proposalId, mode: 'engine', engine: p.engine, teamName: p.teamName, rows, targetTeamId: p.targetTeamId },
      60_000,
    );
  } catch (err) {
    ledger.releaseApproval(p.proposalId);
    return composeFail(504, 'renderer-timeout', String((err && err.message) || err));
  }
  const changes = applied && Array.isArray(applied.engineChanges) ? applied.engineChanges : [];
  if (!applied || !applied.ok || !changes.length) {
    // Hiç yazılmadıysa onay geçerli kalır; KISMİ yazımda jeton harcanmış sayılır
    // (aynı kişilerin motorunu ikinci kez yazmak zararsız ama günlük tek olmalı).
    if (!changes.length) ledger.releaseApproval(p.proposalId);
    return composeFail(502, 'renderer', (applied && applied.error) || 'motor değiştirilemedi.');
  }
  // Açık pane ölçümü: ajanın canlı (execution olmayan) pane'i var mı?
  for (const c of changes) {
    let open = false;
    for (const [, e] of ptys) if (e.agentId === c.agentId && e.disallowSubagent !== true) { open = true; break; }
    c.paneOpen = open;
  }
  const entry = ledger.recordApplied(p.proposalId, {
    teamId: p.targetTeamId || null,
    createdTeam: false,
    employeeIds: changes.map((c) => c.employeeId),
    names: changes.map((c) => c.name),
    wingSlug: applied.wingSlug || null,
    teamName: p.teamName,
    leaderId: p.leaderId,
    scopeGrant: null,
    receipt: null,
    engineChanges: changes,
    mode: 'engine',
  });
  try {
    if (appWindow && !appWindow.isDestroyed()) {
      appWindow.webContents.send('team-compose:applied', {
        proposalId: entry.proposalId,
        mode: 'engine',
        engine: p.engine,
        engineLabel: p.engineLabel,
        teamName: entry.teamName,
        names: entry.names,
        wingSlug: entry.wingSlug,
        undoExpiresAt: new Date(entry.expiresAtMs).toISOString(),
      });
    }
  } catch { /* şerit best-effort — değişiklik GERÇEKLEŞTİ */ }
  logLine(
    `team compose APPLY (engine) → ${p.engine} for ${changes.map((c) => `${c.agentId}${c.paneOpen ? '(pane açık)' : ''}`).join(',')} leader=${req.leaderId}`,
  );
  const body = {
    ok: true,
    mode: 'engine',
    engine: p.engine,
    engineLabel: p.engineLabel,
    proposalId: entry.proposalId,
    teamId: entry.teamId,
    teamName: entry.teamName,
    wingSlug: entry.wingSlug,
    employees: changes.length,
    names: entry.names,
    engineChanges: changes,
    receipt: null,
    unresolvedRoles: [],
    renamed: [],
    undoExpiresAt: new Date(entry.expiresAtMs).toISOString(),
  };
  body.receiptText = teamComposeCore.composeReceiptText(body);
  return { status: 200, body };
}

// ADP-050 — start the loopback delegation bridge once an app window exists.
async function startBridge() {
  // ADP-659 — gözcü köprüden ÖNCE ayağa kalkar: bir önceki oturumdan kalan öksüz
  // kayıtlar (app çökmüş/kapatılmışken biten worker'lar) daha ilk delegasyon
  // gelmeden onarılsın ve lider "sen yokken" özetini alsın.
  try { ensureDelegationSupervisor(); } catch (e) { logLine(`supervisor start failed: ${e.message}`); }
  if (delegationBridge) return;
  try {
    delegationBridge = await delegationBridgeMod.startDelegationBridge({
      resolveWindow: () => appWindow,
      log: logLine,
      ipcMain,
      onBrowserAction: runBrowserAction, // ADP-095 — headed browser automation (CDP)
      // ADP-341 (ADR-026) — risk kapısı: kapı, kararı vermeden ÖNCE gerçek origin'i ve
      // hedef elemanı BURADAN ölçer (ajanın payload'ından değil).
      onBrowserProbe: probeBrowserTarget,
      browserGate: browserGate(),
      onRecyclePane: recycleWorkerPanes, // TASK-MQSBV4EFQ8D6B — free finished worker panes
      // ADP-659 — lider status okudu = ACK; supervisor'ın uyandırma tekrarları durur.
      onLeaderAck: (leaderId) => {
        try { ensureDelegationSupervisor().ack(String(leaderId || '')); } catch { /* best-effort */ }
      },
      // ADP-672 — statü sorusunun KALICI kaynağı. Renderer defteri reload/restart'ta
      // BOŞALIR; lider o zaman ya "aktif delegasyon yok" ya da bayat "working" okur ve
      // patrona yanlış cevap verir. Bu kanal main'in DİSKTEKİ defterinden okur.
      onSupervisorStatus: (leaderId) => {
        try { return ensureDelegationSupervisor().leaderStatus(String(leaderId || '')); } catch { return null; }
      },
      // ADP-303 — lider pane kontrolü (crewpane_pane MCP → bridge → burası).
      // PH-01 — ayrı süreçteki görev-açma yolu (crewpane-task-mcp) sayacı
      // buradan artırır; `telemetryBump` hem heartbeat sayacını hem PostHog
      // olayını TEK yoldan besler (ikisi ayrışamaz).
      onTelemetryBump: (key) => telemetryBump(key),
      onListPanes: listPanesForControl,
      onClosePane: closePanesForControl,
      onFocusPane: focusPaneForControl,
      // ADP-717 — /delegate + /sprint takım kapsamı kapısı. `/pane/close` ile AYNI
      // fonksiyon (teamScope.authorize): iş verebiliyorsan kapatabilirsin, kapatamıyorsan
      // iş de veremezsin. Bu satır olmadan lider yönetemeyeceği ajana iş verebiliyordu.
      // ADP-737 — red artık bir DUVAR değil bir SORU: `cross-team` reddinde sahibe onay
      // kartı çıkar ve cevabı beklenir (izin verilirse aynı çağrı devam eder).
      onAuthorizeScope: ({ action, leaderId, targetScope }) =>
        authorizeTeamScopeInteractive({ action, leaderId, targetScope }),
      // TC-01 — TAKIM KURUCU. Karar (rol süzgeci, tavan, jeton, geri alma günlüğü)
      // main'de; köprü yalnız taşır. `callRenderer` köprünün KENDİ IPC turudur —
      // ikinci bir correlation defteri açmıyoruz.
      onTeamCompose: (payload, transport) => {
        // TC-02 — KULLANICININ "Geri al"ı da AYNI turu kullanır. Köprünün
        // `callRenderer`ı bir kapanıştır ve dışarıdan erişilemez; burada
        // saklanır. İkinci bir correlation defteri açmıyoruz (ADR §7).
        // Şerit ancak bir `apply` TAMAMLANDIKTAN sonra doğduğu için, düğme
        // görünür olduğunda bu tur HER ZAMAN yakalanmış olur.
        composeTransport = transport;
        return teamComposeRequest(payload, transport);
      },
      // ADP-234 — the /report fallback writes under the SELECTED workspace, not the
      // legacy CrewPane path baked into delegationBridge.defaultResultsDir. The
      // CREWPANE_RESULTS_DIR test seam keeps top priority so e2e/tests can still
      // redirect reports without touching the workspace setting.
      // ADP-233 — yeni kanonik yazım yeri `<workspace>/.crewpane/results`
      // (writeReportFile mkdir -p yapar); eski docs/agent-results DONMUŞ legacy,
      // okuma tarafı (reports.ts reportsDirs) dual-read ile taramaya devam eder.
      resolveResultsDir: () => {
        const dir =
          crewpaneEnv.readEnv('RESULTS_DIR') || // ADP-244 Faz 3 — dual-read
          crewpanePaths.resultsDir(agentWorkspaceRoot) ||
          (agentWorkspaceRoot ? path.join(agentWorkspaceRoot, 'docs', 'agent-results') : null);
        // ADP-232-C — root yokken path.join(null,…) THROW ederdi (belirsiz TypeError);
        // ilk-kurulum bitmeden worker da yok, ama ulaşılırsa net hata verilir.
        if (!dir) throw new Error('workspace_not_configured: sonuç dizini için çalışma alanı gerekli');
        return dir;
      },
      // ADP-352 (ADR-024 §5-c) — bağımsız AgentShot'un OPSİYONEL köprüsü.
      onShotAgents: shotBridgeAgents,
      onShotSend: shotBridgeSend,
      // BOARD-IMG-7 — task MCP'nin `attach_to_task`/`attachments` yolu. Renderer
      // IPC'si ile AYNI fonksiyon (ingestTaskAttachment): iki ayrı ingest = iki
      // farklı "geçerli ek" tanımı olurdu.
      onTaskAttachment: (req) => ingestTaskAttachment(req),
      // ADP-538 — /report fallback yazımı da notify-log'a düşer (renderer follow-loop'unu
      // kaçıran completion'lar için kemer+askı; liderin Monitor'u yine tetiklenir).
      onReportNotify: (evt) => notifyLog.appendWorkerEvent(resolveWorkerNotifyPath(evt && evt.department), evt),
      // ADP-622 — ajanların (task MCP) app DB'ye AUTHENTICATED yazabilmesi için taze
      // JWT. Renderer'ın `appdb:token` IPC'siyle AYNI karar + AYNI kaynak (seatGate):
      // kimlik tek yerden türer, iki yüzey ayrışamaz.
      // ADP-646/773 — `appdb:token` IPC'siyle AYNI kapı ve AYNI kod yolu (appDbTokenFor):
      // ajan yolu da lisanssız kimlik almaz, üç yüzey ayrışamaz.
      onAppDbToken: () => appDbTokenFor('bridge:/app-db/token'),
      // BR-01 (ADR-INT-BRIDGE §2) — ENTEGRASYON KEŞFİ: ajanın `crewpane_integrations`
      // aracı buraya düşer. Cevabı main hesaplar çünkü üç kaynak da BURADADIR: katalog,
      // vault'un META görünümü (sır DEĞİL) ve canlı pane defteri.
      onIntegrationsStatus: (req) => integrationsStatusFor(req),
      // ADP-646 — LİSANS KAPISI köprüde de: delegasyon isteği renderer'a hiç
      // gitmeden temiz bir 402 ile döner (yoksa IPC timeout'una düşer, ajan
      // "köprü bozuk" sanırdı). Enjekte edilmezse köprü eski davranışını sürdürür.
      onRequireSeat: (action) => seatDenial(action),
      // BL-01 — PAKET DALGA TAVANI. Lisans kapısı "girebilir mi"yi, bu satır
      // "kaç worker aynı anda"yı kapatır. Sprint reddedilmez; dalga daraltılır ve
      // kullanıcı nudge'ı görür (sessiz kısıtlama = ürünün yavaş göründüğü hata).
      onPlanWave: (requested) => planWaveLimit(requested),
      // VOICE-TRUNC-02 — AgentVoice dikte teslimi (POST /dictation → odaklı yüzey).
      onDictation: (text) => deliverDictationToFocusedSurface(text),
    });
    logLine(`delegation bridge ready port=${delegationBridge.info().port}`);
  } catch (err) {
    logLine(`delegation bridge failed to start: ${err.message}`);
    delegationBridge = null;
  }
}

/**
 * ADP-386 — pane'in VT ekranının son satırları (paneScreen defteri + canlı ekran).
 * Teardown'da livePaneRegistry'ye işlenir; restore yeni pty'nin replay buffer'ını
 * bununla tohumlar ki `claude --resume` sessizken pane SİMSİYAH kalmasın (kanıt:
 * pty:attach bufLen=0 + shot-1784059269700). Best-effort — hata null döner.
 */
function captureScreenTail(entry) {
  if (!entry || !entry.screen) return null;
  try {
    const t = entry.screen.tail({ lines: 40 });
    const lines = [...(t.lines || []), ...(t.live || [])].slice(-40);
    return lines.length ? lines : null;
  } catch {
    return null;
  }
}

/** ADP-386 — tüm canlı pane'lerin ekran kuyruğunu tek seferde registry'ye işle. */
function persistScreenTails() {
  const tails = {};
  for (const [paneId, entry] of ptys) {
    const tail = captureScreenTail(entry);
    if (tail) tails[paneId] = tail;
  }
  try {
    const n = livePaneRegistry.setScreenTails(tails, crewpaneHome());
    if (n) logLine(`quit: screen tail persisted for ${n} pane(s)`);
  } catch { /* best-effort */ }
}

function killAllPtys() {
  persistScreenTails(); // ADP-386 — restore'un tohumlayacağı son ekran görüntüsü
  for (const [paneId, entry] of ptys) {
    entry.preserve = true; // ADP-192 — app teardown → KEEP registry (restore next launch)
    try { entry.child.kill(); } catch { /* already dead */ }
    ptys.delete(paneId);
  }
}

// ---------------------------------------------------------------------------
// ADP-192 (SPRINT-AD-23) — restart-resume: re-spawn the agents that were running
// when the app last shut down (a .dmg update / quit→reopen), each on its prior
// claude session (`--resume <sessionId>`) so the conversation CONTINUES. Runs once
// per process, on the first app-window load. Unattended by default
// ([[autopilot-auto-resume]]); kill-switch CREWPANE_DISABLE_RESTORE=1. Best-effort
// per pane — one bad entry never blocks the others or crashes the launch.
// ---------------------------------------------------------------------------

/**
 * spawnPty opts that re-open an agent on its prior session (`--resume`). Shared
 * by BOTH resume paths: restoreLivePanes (registry snapshot entries, all fields)
 * and the pty resume daemon's respawn (queue entries — engine/cwd/agentId/
 * sessionId only; the optional fields fall through as undefined/null).
 */
// ═══ HATA-12-B — TEK MOTOR KAYNAĞI (üç restore yolu) ═════════════════════════
// HATA-12 hükmü çağırana emanetti ve iki çağıran onu vermiyordu (DISC-TRIAGE-03 §4.6:
// `acceptRecoverablePanes` ve pty resume daemon'ın `respawnPane`'i). Artık motoru
// ÇÖZÜMLEYİCİ okur; unutulması yapısal olarak mümkün değil.
// `CREWPANE_ENGINE_DRIFT_OFF=1` → hüküm üretilmez (kaçış/kontrol kolu: kusurun
// kendisi geri gelir; e2e'de "düzeltmeyi sök" ölçümü bununla yapılır).
const paneEngineResolver = agentEngineMirror.createResolver({
  homedir: () => crewpaneHome(),
  log: (line) => logLine(line),
  disabled: () => process.env.CREWPANE_ENGINE_DRIFT_OFF === '1',
});

function respawnOptsFromEntry(entry, ctx = {}) {
  const opts = {
    command: entry.engine,
    cwd: entry.cwd || undefined,
    agentId: entry.agentId || null,
    // PANE-RESTORE-DUP-01 — PANE'İN KALICI KİMLİĞİ GERİ YÜKLEMEDE TAŞINIR. Yeni pane
    // yeni bir `paneId` (koltuk numarası) alır ama AYNI defter satırını günceller;
    // bu alan olmadan restore edilen çıplak motor pane'i her açılışta İKİNCİ bir satır
    // yazıyordu (ölçüldü: 3 pane → 4 açılışta 24).
    restoreKey: entry.restoreKey || undefined,
    department: entry.department || null,
    label: entry.label || null,
    role: entry.role || undefined,
    plain: entry.plain === true,
    browserCapable: entry.browserCapable === true,
    disallowSubagent: entry.disallowSubagent === true,
    systemPrompt: entry.systemPrompt || undefined,
    sessionId: entry.sessionId || undefined,
    // ADP-565 — resume on the SAME model the pane was launched with (--model is a
    // per-launch flag, not conversation state, so it must be re-passed every boot).
    model: entry.model || undefined,
    // ADP-595 — ditto for the codex custom provider (`-c model_provider=…`).
    provider: entry.provider || undefined,
    resume: true,
    // ADP-386 — önceki oturumun son ekran satırları: spawnPty replay buffer'ını
    // bununla tohumlar → restore edilen pane, engine sessizken de içerik gösterir.
    screenTail: Array.isArray(entry.screenTail) ? entry.screenTail : undefined,
  };
  // HATA-12 / HATA-12-B — MOTOR SÜRÜKLENMESİ. `entry.engine` pane SPAWN EDİLİRKEN
  // yazılan motordur; kullanıcı o pane açıkken (ya da pane limitte düştükten sonra)
  // ajanın motorunu değiştirmiş olabilir. Hüküm ARTIK ÇAĞIRANA SORULMAZ: çözümleyici
  // ajanın güncel motorunu kendi okur. Sürüklenme yoksa çıktı bugünküyle BİT-BİT
  // aynıdır; ayrıştığında pane GÜNCEL motorla ve TEMİZ doğar — eski motorun
  // oturumu/modeli/sağlayıcısı/ekranı taşınmaz (gerekçe: applyEngineDrift).
  return paneEngineResolver.applyTo(opts, entry, ctx.where || 'restore');
}
// ═══════════════════════════════════════════════════════════════════════════
// ADP-734 Kapı 2 — "KURTARILABİLİR PANE" TEKLİFİ (sessizce atma, SOR)
// ═══════════════════════════════════════════════════════════════════════════
// İki tetikleyicisi var: (1) açılışta bulunan ama BAYAT bir kayıt, (2) çalışırken
// defterin beklenenden AZ pane ile yazılması. İkisinde de davranış aynı: kaydı
// DİSKE yaz (kalıcı, incelenebilir), log'a bas, pencereye haber ver. Otomatik pane
// AÇMAZ — kullanıcı/lider karar verir. `panes:restoreRecoverable` IPC'si teklifi
// uygular (UI düğmesi Bumblebee'nin işi; sözleşme burada hazır).
const RECOVERABLE_FILE = 'live-panes.recoverable.json';
let pendingRecoverable = null;

// ═══ PANE-RESTORE-DUP-01 — İKİ SAYI, İKİ AYRI İŞ ════════════════════════════
// `BARE_RESTORE_ASK_THRESHOLD` — bu kadar ÇIPLAK motor pane'inden fazlası otomatik
//   AÇILMAZ, sorulur (ajanlı pane'ler muaf). 12 = kartın verdiği değer; makul bir
//   ekranda aynı anda duran pane sayısının üstü. 0 → kapı kapalı (kaçış kolu).
// `LEDGER_BLOAT_WARN` — defter bu kadar satırı geçtiyse ÜRÜNDE tespit için Sentry'ye
//   UYARI düşer (hata değil): kullanıcı şikâyet etmeden önce görelim. Eren'in
//   vakasında sayı 192'ydi ve tek uyarı satırı bile yoktu.
const BARE_RESTORE_ASK_THRESHOLD = Number.isFinite(Number(process.env.CREWPANE_BARE_RESTORE_ASK))
  ? Number(process.env.CREWPANE_BARE_RESTORE_ASK)
  : 12;
const LEDGER_BLOAT_WARN = 40;

/**
 * PANE-RESTORE-DUP-01 (5) — DEFTER ŞİŞMESİ TELEMETRİSİ. Yeni bir hata yolu AÇILMAZ:
 * mevcut TEK musluktan (`reportModuleFault` → OBS-02) `level:'warning'` ile geçer,
 * yani aynı olay bildirim merkezinde de görünür. Yalnız EŞİĞİ AŞAN açılışta basılır
 * (her açılışta değil) — gürültü, uyarıyı işe yaramaz kılar.
 */
function reportLedgerBloat(before, after) {
  if (!Number.isFinite(before) || before <= LEDGER_BLOAT_WARN) return;
  reportModuleFault({
    module: 'pane',
    label: 'live-panes',
    level: 'warning',
    message:
      `live-panes defteri ${before} kayıt (eşik ${LEDGER_BLOAT_WARN}) — ` +
      `tekilleştirmeden sonra ${after}`,
    location: 'restoreLivePanes',
    stopped: false,
    fatal: false,
  });
}

function offerRecoverablePanes(win, entries, meta = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!list.length) return null;
  pendingRecoverable = { at: Date.now(), ...meta, entries: list };
  const file = path.join(livePaneRegistry.crewpaneDir(crewpaneHome()), RECOVERABLE_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(pendingRecoverable, null, 2));
  } catch { /* teklif diske yazılamasa da log + IPC ayakta */ }
  logLine(
    `restore: ${list.length} pane KURTARILABİLİR (otomatik açılmadı, sebep=${meta.reason || '-'}): ` +
      list.map((e) => `${e.agentId ?? '-'}=${e.sessionId ?? '-'}`).join(', ') +
      ` · teklif=${file}`,
  );
  try {
    if (win && !win.isDestroyed()) {
      win.webContents.send('panes:recoverable', {
        count: list.length,
        reason: meta.reason || null,
        source: meta.source || null,
        agents: list.map((e) => ({
          agentId: e.agentId ?? null,
          department: e.department ?? null,
          // ENG-05 — motor bilinmiyorsa `null` gider, 'claude' DEĞİL: teklif kartı
          // kullanıcıya olmayan bir motoru vaat etmesin (kabul edilse de açılmaz).
          engine: e.engine ?? null,
          sessionId: e.sessionId ?? null,
        })),
      });
    }
  } catch { /* pencere yoksa dosya + log yeterli */ }
  return pendingRecoverable;
}

/** Teklifi UYGULA — bekleyen kurtarılabilir pane'leri gerçekten aç. */
function acceptRecoverablePanes(win) {
  let offer = pendingRecoverable;
  if (!offer) {
    try {
      offer = JSON.parse(
        fs.readFileSync(path.join(livePaneRegistry.crewpaneDir(crewpaneHome()), RECOVERABLE_FILE), 'utf8'),
      );
    } catch { offer = null; }
  }
  const entries = offer && Array.isArray(offer.entries) ? offer.entries : [];
  if (!entries.length) return { ok: false, restored: 0, error: 'kurtarılabilir kayıt yok' };
  // ADP-761 — "zaten canlı ajanı atla" kontrolünün kopyası KALDIRILDI: tek kapı
  // `spawnPty` içinde (`dedupeSpawnForAgent`) → reuse'da `reused:true` döner.
  let restored = 0;
  // PLAN-FIX-01 (F-4) — plan tavanına takılan kayıtlar KAYBOLMAZ: teklif bir sonraki
  // sefere onlarla ayakta kalır (kullanıcı bir ajanı kapatınca kaldığı yerden açar).
  const planSkipped = [];
  for (const entry of entries) {
    try {
      const res = spawnPty(win || appWindow, { ...respawnOptsFromEntry(entry, { where: 'teklif' }), spawnIntent: 'restore' });
      if (res && res.planLimited) { planSkipped.push(entry); restoreSkippedByPlan += 1; continue; }
      if (res && res.reused) continue;
      restored += 1;
    } catch (e) {
      logLine(`restore(offer): respawn failed agent=${entry.agentId ?? '-'}: ${e.message}`);
    }
  }
  // ADP-761 — teklif KABUL edildi = kaynak tüketildi. Yabancı kökteki dosya emekliye
  // ayrılmazsa aynı bayat kayıtlar her açılışta yeniden teklif edilir (ölümsüz defter).
  const offerSource = offer && offer.source;
  if (restored && offerSource && offerSource.file) {
    const activeRoot = livePaneRegistry.crewpaneDir(crewpaneHome());
    if (offerSource.root !== activeRoot) {
      const retired = livePaneRegistry.retireConsumedSource(offerSource.file);
      logLine(`restore(offer): kaynak emekliye ayrıldı ${offerSource.file}${retired ? ` → ${retired}` : ' (BAŞARISIZ)'}`);
    }
  }
  // PLAN-FIX-01 (F-4) — kısıtlanan restore SESSİZ OLMAZ ve teklifi TÜKETMEZ.
  // Teklif KULLANICI EYLEMİDİR (kartta "geri getir"e bastı) → nudge GÖSTERİLİR.
  if (planSkipped.length) {
    pendingRecoverable = { ...(offer || {}), entries: planSkipped };
    logLine(
      `restore(offer): plan tavanı — ${planSkipped.length} pane açılmadı (teklif duruyor): `
        + planSkipped.map((e) => `${e.agentId ?? '-'}=${e.sessionId ?? '-'}`).join(', '),
    );
    planDenial('agents', ptys.size, { variant: 'restore', context: { pending: planSkipped.length } });
  } else {
    pendingRecoverable = null;
  }
  logLine(`restore(offer): ${restored}/${entries.length} pane açıldı`);
  return { ok: true, restored, total: entries.length, planSkipped: planSkipped.length };
}

function restoreLivePanes(win) {
  if (panesRestored || RESTORE_DISABLED || APP_PROBE || MODE === 'spike') return;
  panesRestored = true;
  // PANE-RESTORE-DUP-01 (3) — ŞİŞMİŞ DEFTERİN GÖÇÜ. Fix ileriye dönüktür; kullanıcının
  // diskinde DURAN kopyalar (Eren'in dev profili: 192 kayıt) temizlenmezse düzeltmenin
  // İLK açılışı yine 192 pty doğurur. Yedekli + idempotent: kopya yoksa dosyaya
  // dokunulmaz. Restore'un GERİ KALANINI asla bloklamaz (best-effort).
  try {
    const compact = livePaneRegistry.compactRegistry(crewpaneHome());
    if (compact.changed) {
      logLine(
        `restore: defter tekilleştirildi ${compact.before} → ${compact.after} kayıt ` +
          `(${compact.removed} kopya düştü; yedek=${compact.backup || 'ALINAMADI'})`,
      );
    }
    reportLedgerBloat(compact.before, compact.after);
  } catch (e) {
    logLine(`restore: defter tekilleştirilemedi: ${e.message}`);
  }
  let snapshot;
  try {
    snapshot = livePaneRegistry.restoreSnapshot(crewpaneHome());
  } catch (e) {
    logLine(`restore: snapshot read failed: ${e.message}`);
    return;
  }
  // TASK-MRDXOGZJDQLJG + ADP-734 Kapı 1 — the registry may come up EMPTY although
  // agents were running: the 22:50 self-update wipe, OR (ADP-732) a data-root
  // migration that moved the ledger somewhere this build does not look. So the
  // fallback is no longer "this root's quit snapshot" — it is EVERY data root on
  // this machine (instance root + accounts/*), registry AND quit snapshot, freshest
  // first. The chosen source is always LOGGED: a silent empty ledger is what made
  // 7 live agent sessions vanish from the screen without a single error line.
  let found = null;
  try { found = livePaneRegistry.discoverRecoverable(crewpaneHome()); } catch { found = null; }
  let fromFallback = false;
  // ADP-761 — keşif YABANCI bir kökten (aktif kök değil) beslendiyse o dosya
  // tüketildikten sonra emekliye ayrılmalı; yoksa aynı ölü kayıtlar her açılışta
  // yeniden "ek" olarak katılır (ölümsüz defter → aynı ajana ikinci pane).
  let consumedForeign = null;
  const activeRootNow = livePaneRegistry.crewpaneDir(crewpaneHome());
  // ═══ PANE-RESTORE-DUP-01 — KÖK NEDENİN KAPATILDIĞI YER ═══════════════════
  // ÖLÇÜLEN DAVRANIŞ (e2e-BEFORE-fix.txt): 3 çıplak pane 4 açılışta 24 oldu, log
  //   `restore: kaynak=snapshot kök=…/accounts/local (12 pane, …) → +12 ek`
  //   `restore: 24/24 agent pane(s) resumed`
  // İKİ AYRI HATA vardı, ikisi de burada:
  //   (1) `extra` filtresi `!e.agentId ||` ile BAŞLIYORDU: agentId'siz her kayıt
  //       KOŞULSUZ "ek" sayılıyordu. Kimlik artık `identityKey` (restoreKey →
  //       agentId → motor|etiket|cwd), yani çıplak pane de "zaten biliniyor"
  //       diyebiliyor.
  //   (2) Kaynak, AKTİF KÖKÜN KENDİ quit-snapshot'ı olabiliyordu — yani az önce
  //       okuduğumuz defterin BAYT KOPYASI. Kendi kopyanı kendine "ek" diye
  //       eklemek listeyi her açılışta İKİYE KATLAR. Kapı 1'in amacı BAŞKA bir
  //       kökten (hesap göçü / sürüm geri dönüşü) kaybı kurtarmaktı; defter
  //       DOLUYKEN kendi kökünün kopyası bir kurtarma değil, bir çoğaltmadır.
  if (found && !found.stale && !(snapshot.length && found.source.root === activeRootNow)) {
    const known = new Set(snapshot.map((e) => livePaneRegistry.identityKey(e)));
    const extra = found.entries.filter((e) => !known.has(livePaneRegistry.identityKey(e)));
    if (!snapshot.length) {
      snapshot = found.entries;
      fromFallback = true;
    } else if (extra.length) {
      // Defter DOLU ama keşif daha fazlasını biliyor (kısmen boşalmış defter):
      // birleştir — defterdeki kayıt kazanır, eksikler keşiften tamamlanır.
      snapshot = snapshot.concat(extra);
    }
    if (fromFallback || extra.length) {
      // Eski satır KORUNUR: "quit snapshot'a düşüldü" ifadesi hem operatörün hem de
      // TASK-MRDXOGZJDQLJG e2e'sinin aradığı kanıt cümlesidir.
      if (fromFallback && found.source.kind === 'snapshot') {
        logLine(`restore: fell back to quit snapshot (${snapshot.length} pane(s))`);
      }
      logLine(
        `restore: kaynak=${found.source.kind} kök=${found.source.root} ` +
          `(${found.source.count} pane, ${new Date(found.source.at).toISOString()}) → ${fromFallback ? 'tamamı' : `+${extra.length} ek`}`,
      );
      // Aktif kök = clearAll'ın boşalttığı kök. Kaynak BAŞKA bir kökse (hesap göçü /
      // sürüm geri dönüşü artığı) o dosyayı biz tüketiyoruz → aşağıda emekliye ayrılır.
      if (found.source.root !== activeRootNow) consumedForeign = found.source;
    }
  }
  if (!snapshot.length) {
    // ADP-734 Kapı 2 — BAYAT KAYIT ARTIK SESSİZCE ATILMAZ. ADP-732'de 23 dakikalık
    // gecikme, 7 oturumluk kusursuz bir yedeği çöpe attırdı (SNAPSHOT_MAX_AGE_MS).
    // Otomatik açmıyoruz (o kadar eskisini diriltmek yanlış olabilir) — TEKLİF ediyoruz.
    if (found && found.stale) {
      offerRecoverablePanes(win, found.entries, {
        reason: 'stale-snapshot',
        source: found.source,
      });
      return;
    }
    logLine('restore: no live agent panes to resume');
    // ADP-734 Kapı 3 — defter boş ama JOURNAL kimin hangi oturumda olduğunu bilir.
    try {
      const known = paneSessionsJournal.recoverSessions(crewpaneHome());
      if (known.length) {
        logLine(
          `restore: journal ${known.length} ajan oturumu biliyor (kurtarma için): ` +
            known.map((k) => `${k.agentId}=${k.sessionId}`).join(', '),
        );
      }
    } catch { /* teşhis best-effort */ }
    return;
  }
  // ═══ PANE-RESTORE-DUP-01 (2) — ÜST SINIR GÜVENLİĞİ: ENGEL DEĞİL, SORU ═══════
  // Çoğaltma kapatıldı ama defter BAŞKA bir yoldan da kalabalıklaşabilir (kullanıcı
  // gerçekten 30 motor pane'i açtı, ya da bu fix'ten ÖNCEKİ bir sürüm şişirdi ve
  // kayıtların hepsi meşru görünüyor). Böyle bir listeyi SESSİZCE açmak Eren'in
  // yaşadığı tabloyu (202 alt süreç, 3,4 GB) tekrar üretir. Kural:
  //   • AJANLI pane'ler HER ZAMAN otomatik geri gelir — çalışan iş bekletilmez.
  //   • ÇIPLAK motor pane'i eşiği aşarsa AÇILMAZ, TEKLİF EDİLİR (kart + dosya + log).
  //     Kayıtları KAYBOLMAZ: `clearAll` sonrası çakışmayan bir anahtarla geri yazılır
  //     (PLAN-FIX-01'in `plan-hold:` deseniyle aynı gerekçe).
  const askHeld = [];
  if (BARE_RESTORE_ASK_THRESHOLD > 0) {
    const bare = snapshot.filter((e) => !e.agentId);
    if (bare.length > BARE_RESTORE_ASK_THRESHOLD) {
      askHeld.push(...bare);
      snapshot = snapshot.filter((e) => e.agentId);
      offerRecoverablePanes(win, askHeld, { reason: 'bare-pane-threshold' });
      logLine(
        `restore: ${askHeld.length} çıplak motor pane'i OTOMATİK AÇILMADI (eşik=${BARE_RESTORE_ASK_THRESHOLD}) — ` +
          'kullanıcıya soruldu; ajanlı pane\'ler normal geri yüklenir',
      );
    }
  }

  // Consume the snapshot: clear the stale (old-paneId) entries; each successful
  // re-spawn re-records itself under its NEW paneId with the SAME sessionId, so a
  // later restart resumes again (self-healing).
  // TASK-MRDXOGZJDQLJG — write-ahead first: clearAll..re-record used to be an
  // unrecoverable consume window (a respawn failure or a crash here lost every
  // session for good). Skipped when we are ALREADY restoring from the snapshot —
  // snapshotting the empty registry would clobber it.
  if (!fromFallback) {
    try { livePaneRegistry.writeQuitSnapshot(crewpaneHome()); } catch { /* best-effort */ }
  }
  try { livePaneRegistry.clearAll(crewpaneHome()); } catch { /* best-effort */ }
  // ADP-761 — YABANCI kökten tükettiysek o dosyayı da tüketilmiş SAY: yeniden
  // adlandırılır (silinmez — incelenebilir kalır). Kayıtlar kaybolmaz: her respawn
  // kendini AKTİF köke yeni paneId'siyle yazar (self-healing zinciri korunur).
  if (consumedForeign) {
    const retired = livePaneRegistry.retireConsumedSource(consumedForeign.file);
    logLine(
      retired
        ? `restore: yabancı kök tüketildi → emekliye ayrıldı ${consumedForeign.file} → ${retired}`
        : `restore: yabancı kök tüketildi ama emekliye AYRILAMADI (${consumedForeign.file}) — bir sonraki açılışta yeniden keşfedilebilir`,
    );
  }

  // Double-spawn guard (ADP-133 pattern): never resurrect an agent that is already
  // live in this process (e.g. the renderer also opened it).
  // ADP-761 — bu kontrolün KENDİ kopyası KALDIRILDI: karar artık `spawnPty`'nin
  // içindeki tek kapıda (`dedupeSpawnForAgent`). Zaten canlı bir ajan için çağrı
  // `reused:true` döner; hem defterdeki İKİ AYNI ajan kaydı (birleştirilmiş yabancı
  // defterin ürettiği hâl) hem de renderer'ın paralel açtığı pane aynı yolla ele alınır.
  // HATA-12-B — ayna okuması BURADAN KALKTI: motoru artık `paneEngineResolver` okur
  // (tek kaynak, mtime damgalı önbellek) ve hükmü `respawnOptsFromEntry` uygular.
  // Bu döngü bir açılışta 20+ kayıt gezebilir; damga değişmediği sürece dosya bir kez
  // okunur — eski "döngü öncesi tek okuma" kazancı korunur, ama kalan iki restore
  // yolu da aynı kaynağı kullanır.
  const restored = [];
  let alreadyLive = 0;
  // PLAN-FIX-01 (F-4) — plan tavanı yüzünden AÇILMAYAN kayıtlar. Döngü İÇİNDE
  // deftere geri yazılmazlar: `paneId` her açılışta SIFIRDAN sayılır (pane-1, pane-2…),
  // yani bu turda doğan pane'ler eski kayıtların ANAHTARINI ezerdi (ölçüldü: defter
  // 5 yerine 3 kaldı). Toplanır, döngü bitince ÇAKIŞMAYAN bir anahtarla yazılırlar.
  const heldByPlan = [];
  for (const entry of snapshot) {
    // ENG-05 — motoru BİLİNMEYEN kayıt (defterde `engine:null`) restore EDİLMEZ ve bu
    // sessiz kalmaz. Eskiden böyle bir kayıt claude'a düşürülüp claude ile açılırdı —
    // yani yanlış ikiliye yanlış oturum. Doğru davranış: açma, ama kaydı gören
    // operatöre söyle (defter satırı duruyor, elle açılabilir).
    if (!entry.engine) {
      logLine(
        `restore: MOTOR BİLİNMİYOR → atlandı agent=${entry.agentId ?? '-'} pane=${entry.paneId ?? '-'} ` +
          `(engine=null; claude varsayılmadı — kayıt defterde duruyor)`,
      );
      continue;
    }
    // ═══ HATA-12 — DEFTERİ AJANIN GÜNCEL MOTORUYLA KARŞILAŞTIR ══════════════
    // ÖLÇÜLEN KUSUR (ödeme yapmış müşteri, Discord 02.09): kullanıcı ekip liderinin
    // motorunu claude→codex yaptı; kayıt değişti ama YENİDEN BAŞLATMAK da kurtarmadı,
    // çünkü burası defterin yazdığı motoru + eski oturumu KOŞULSUZ diriltiyordu.
    // Ayrıştıysa: SESSİZCE yanlış motorla açma (bugünkü davranış = kusurun ta kendisi);
    // güncel motorla TEMİZ spawn et ve ölçümü tek satır logla — HATA-12-B'den sonra
    // karşılaştırmayı da logu da `respawnOptsFromEntry` (çözümleyici) yapar.
    // resume:true + a valid sessionId → `--resume`; an invalid/missing id falls back
    // to a fresh identityful spawn inside buildSpawn (ADP-192 broken-session graceful).
    const opts = { ...respawnOptsFromEntry(entry, { where: 'yeniden-başlatma' }), spawnIntent: 'restore' };
    try {
      const res = spawnPty(win, opts);
      // PLAN-FIX-01 (F-4) — tavana takıldı: pane AÇILMAZ ama KAYIT KAYBOLMAZ.
      // Yukarıdaki `clearAll()` defteri boşalttı ve yalnız yeniden doğan pane'ler
      // kendilerini geri yazıyor; bu satır olmadan "açılmadı" hükmü sessizce
      // "kaydı sil"e dönüşür ve kullanıcı bir ajanı kapatsa bile geri getiremezdi.
      // Kayıt ESKİ paneId'siyle geri yazılır (canlı bir pane'e ait değil, bir DEFTER
      // satırıdır) — bir sonraki açılışta yine aday olur.
      if (res && res.planLimited) {
        heldByPlan.push(entry);
        restoreSkippedByPlan += 1;
        continue;
      }
      if (res && res.reused) {
        alreadyLive += 1;
        // ADP-905 — KRİTİK: yukarıdaki `clearAll()` defteri boşalttı ve YALNIZ yeniden
        // doğan pane'ler kendilerini geri yazar. Restore artık süreç içinde İKİNCİ kez
        // koşabildiği için (pencere kapat/aç), yaşayan pane'in kaydı bu yolda sessizce
        // SİLİNİRDİ: ajan ekranda canlı görünür ama bir sonraki gerçek restart onu
        // restore edemezdi. Kayıt kendi alanlarıyla CANLI paneId altına geri yazılır.
        try {
          livePaneRegistry.recordPane(res.paneId, entry, crewpaneHome());
        } catch (e) {
          logLine(`restore: canlı pane defteri geri yazılamadı paneId=${res.paneId}: ${e.message}`);
        }
        logLine(`restore: skip already-live agent=${entry.agentId ?? '-'} (pane ${res.paneId} reuse)`);
        continue;
      }
      // HATA-12 — RAPORLANAN MOTOR/KİP ARTIK GERÇEKTEN SPAWN EDİLENDİR. Bu iki değer
      // `entry.*`ten okunuyordu; motor sürüklendiğinde `entry.engine`/`entry.sessionId`
      // ESKİ motorun alanlarıdır ⇒ pane CODEX doğarken hem log hem de renderer'a giden
      // "geri yüklendi" listesi "claude / resume" diyordu (ölçüldü: spike-log 05.09).
      // Yanlış teşhis üreten bir log, olmayan bir hatayı aratır — kaynak `opts`tur.
      const spawnedEngine = opts.command;
      const resumed = opts.resume === true && spawnedEngine === 'claude' && agentRunner.isUuid(opts.sessionId);
      restored.push({
        agentId: entry.agentId,
        department: entry.department,
        paneId: res.paneId,
        engine: spawnedEngine,
        resumed,
      });
      logLine(
        `restore: respawned agent=${entry.agentId ?? '-'} dept=${entry.department ?? '-'} ` +
          `engine=${spawnedEngine} mode=${resumed ? 'resume' : 'fresh'} paneId=${res.paneId}`,
      );
    } catch (e) {
      logLine(`restore: respawn failed agent=${entry.agentId ?? '-'}: ${e.message}`);
    }
  }
  if ((restored.length || alreadyLive) && !win.isDestroyed()) {
    // Surface it to the renderer (a toast / the ADP-042 notification bell already
    // shows the panes as they re-appear via pty:list). Harmless if no listener.
    // ADP-905 F3 — `survived`: pencere kapanıp açıldığında ÖLMEDEN yaşamaya devam eden
    // ajan sayısı. Kullanıcının korkusu ("hepsi gitti") yalnız restore edilenlerle
    // giderilemez: asıl haber, hiçbirinin ölmemiş olmasıdır.
    win.webContents.send('panes:restored', {
      count: restored.length,
      agents: restored,
      survived: alreadyLive,
    });
  }
  logLine(`restore: ${restored.length}/${snapshot.length} agent pane(s) resumed (already-live=${alreadyLive})`);
  // PLAN-FIX-01 (F-4) — KISITLANAN RESTORE SESSİZ OLMAZ, ama AÇILIŞTA DUVAR DA OLMAZ.
  // BL-02 kuralı: kullanıcı bir şey İSTEMEDEN açılan ekranda yükseltme duvarı yoktur
  // → `notify:false`. Kanıt log'da kalır; kullanıcı Ayarlar'daki kullanım sayacında
  // (`plan:get`) canlı/tavan farkını zaten görür.
  // PANE-RESTORE-DUP-01 — eşikte BEKLETİLEN çıplak pane'lerin defter satırları geri
  // yazılır (yukarıdaki `clearAll()` defteri boşalttı). Anahtar canlı bir pane'inkiyle
  // çakışamaz; kayıt bir pane'e değil bir DEFTER SATIRINA aittir.
  if (askHeld.length > 0) {
    let held = 0;
    for (const entry of askHeld) {
      try {
        livePaneRegistry.recordPane(`ask-hold:${livePaneRegistry.identityKey(entry)}`, entry, crewpaneHome());
        held += 1;
      } catch (e) {
        logLine(`restore: eşik — kayıt geri yazılamadı pane=${entry.label ?? '-'}: ${e.message}`);
      }
    }
    logLine(`restore: eşik — ${askHeld.length} çıplak pane bekletildi (${held} kaydı defterde duruyor)`);
  }
  if (heldByPlan.length > 0) {
    // KAYIT KAYBOLMAZ. Yukarıdaki `clearAll()` defteri boşalttı ve yalnız yeniden
    // doğan pane'ler kendilerini geri yazıyor; bu blok olmadan "açılmadı" hükmü
    // sessizce "kaydı sil"e dönüşürdü — kullanıcı bir ajanı kapatsa bile geri
    // getiremezdi. Anahtar CANLI bir pane'inkiyle çakışamayacak biçimde türetilir
    // (`pane-N` sayacı her açılışta sıfırlanır); kayıt canlı bir pane'e değil,
    // bir DEFTER SATIRINA aittir ve bir sonraki açılışta yine aday olur.
    let held = 0;
    for (const entry of heldByPlan) {
      const key = `plan-hold:${entry.agentId || entry.sessionId || `${held}`}`;
      try {
        livePaneRegistry.recordPane(key, entry, crewpaneHome());
        held += 1;
      } catch (e) {
        logLine(`restore: plan tavanı — kayıt geri yazılamadı agent=${entry.agentId ?? '-'}: ${e.message}`);
      }
    }
    logLine(
      `restore: plan tavanı — ${heldByPlan.length} pane açılmadı (${held} kaydı defterde duruyor; `
        + `bir ajanı kapatınca elle açılabilir)`,
    );
  }
}

// ---------------------------------------------------------------------------
// ADP-limit (ADR-007 Faz 4) — in-app pty auto-resume daemon. The tmux daemon
// (scripts/resume-daemon.mjs) only sees tmux panes; agents running in the app's
// own node-pty panes had NO limit watcher at all — a limited in-app agent waited
// forever. This runs ResumeDaemonCore inside main, fed from the `ptys` Map.
// ---------------------------------------------------------------------------

/**
 * Where resume + worker-completion notices land. ADP-545 — eski mantık packaged
 * app'te instance-dir'e (resume-notifications.log) düşüyordu; orayı HİÇBİR lider
 * izlemez (Monitor tail'leri workspace'teki docs/.agent-notifications dosyalarında)
 * → ADP-538 emit'i kurulu app'te yanlış dosyaya yazacaktı, auto-trigger yine ölü.
 * Artık notifyPath.cjs aday-probe'u: env dikişi → departman docs'u → workspace
 * crewpane/docs (kurulum protokol hedefi) → root docs (dev) → instance fallback.
 */
function resolveWorkerNotifyPath(department) {
  return notifyPathMod.resolveNotifyPath({
    envOverride: process.env.CREWPANE_RESUME_NOTIFY,
    department,
    workspaceRoot: agentWorkspaceRoot || (!app.isPackaged ? REPO_ROOT : null),
    mapping: agentSettings.readSettings().departmentDirs,
    log: logLine,
    instanceFallback: path.join(instancePaths.crewpaneHome(crewpaneHome()), 'resume-notifications.log'),
  });
}

function resolveResumeNotifyPath() {
  return resolveWorkerNotifyPath(undefined);
}

// ═══════════════════════════════════════════════════════════════════════════
// ADP-659 — DELEGASYON SUPERVISOR: main-side, disk-defterli otopilot gözcüsü
// ═══════════════════════════════════════════════════════════════════════════
// Neden BURADA (renderer'da değil): ADP-538/545/561/563/575'in hepsi doğru fix'lerdi
// ama hepsi renderer'da yaşıyor. Renderer reload'u (crashWatchdog win.reload, HMR,
// OOM) uçuştaki her nöbeti siler ve o alt-görev sonsuza dek öksüz kalır → ajan
// "meşgul", pane "working" hayaleti, kuyruk durur. Main süreci pencere ömründen
// bağımsızdır ve pty defterinin + dosya sisteminin SAHİBİDİR: tamamlanmayı renderer'a
// hiç sormadan ölçebilir. Kayıt DİSKTE → app restart'ı bile takibi kesmez.

let delegationSupervisor = null;
let supervisorSweepTimer = null;

// ── ADP-667 — BİLDİRİM KAPISI (tekilleştirme + toplama) ────────────────────
// notify-log'a yazan TEK boğaz. Renderer follow-loop'u (IPC 'notify:workerEvent')
// ve main supervisor'ı (`notifyOnce`) AYNI kapıdan geçer → "aynı bitiş iki-üç kez"
// yapısal olarak imkânsız; aynı pencerede biten işler tek satırda toplanır.
let notifyGateInstance = null;
function notifyGate() {
  if (notifyGateInstance) return notifyGateInstance;
  const envNum = (name, fallback) => {
    const v = Number(crewpaneEnv.readEnv(name));
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  notifyGateInstance = notifyGateMod.createNotifyGate({
    // ADP-586 — notify dosyası repo'ya commit'lenir → olay maskeden geçirilerek yazılır.
    emit: (evt) =>
      notifyLog.appendWorkerEvent(resolveWorkerNotifyPath(evt && evt.department), secretRedactor.redactDeep(evt)),
    log: (line) => logLine(line),
    opts: {
      coalesceMs: envNum('NOTIFY_COALESCE_MS', notifyGateMod.DEFAULTS.coalesceMs),
      dedupeTtlMs: envNum('NOTIFY_DEDUPE_TTL_MS', notifyGateMod.DEFAULTS.dedupeTtlMs),
    },
  });
  return notifyGateInstance;
}

/** Supervisor'ın pane görünümü — main'in pty defteri (tek gerçek). */
function supervisorListPanes() {
  const out = [];
  for (const [paneId, entry] of ptys) {
    out.push({
      paneId,
      agentId: entry.agentId || null,
      command: entry.command || null,
      bytes: entry.bytes || 0,
      // Delegasyon EXECUTION pane'i mi (ADP-136)? Lider/insan pane'i ASLA reap edilmez.
      disallowSubagent: entry.disallowSubagent === true,
    });
  }
  return out;
}

/**
 * Kanıt parmak izi — İÇERİK hash'i (mtime DEĞİL; ADP-575'te mtime hipotezi elenmişti).
 * null = dosya yok. Supervisor baseline'ı da bu fonksiyonla alınır → algoritma
 * renderer'ınkiyle (djb2) aynı olmak ZORUNDA değil, karşılaştırma hep main-içi.
 */
function supervisorFingerprint(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * TEK pane'i geri kazan (hayalet reap). recycleWorkerPanes'in tek-pane hali —
 * AYNI politika: claude/codex → soft reset (/clear, warm oturum korunur, ADP-266),
 * bütçe dolmuşsa / shell ise kill. Lider pane'i buraya HİÇ gelmez (çağıran eler).
 */
function reapWorkerPane(paneId, why) {
  const entry = ptys.get(paneId);
  if (!entry || entry.disallowSubagent !== true) return false;
  const resetCmd = resetCommandFor(entry.command);
  const overBudget = (entry.taskCount || 0) + 1 >= MAX_TASKS_PER_SESSION;
  if (!resetCmd || overBudget) {
    killPane(paneId, entry, entry.agentId, why);
    return true;
  }
  // ADP-667 — HAYALET REAP ARTIK EKRANI SİLMEZ. Eskiden burada anında `/clear`
  // yazılıyordu: worker'ın son çıktısı (özet/hata/commit satırı) o saniyede yok
  // oluyordu ve pane bomboş bekliyordu. Eren: "aradaki sürede terminale bakıp ne
  // yapmış OKUMAK istiyorum". Pane yalnız BAYRAKLANIR; gerçek temizlik sıradaki
  // dispatch'in yazımından hemen önce (renderer'ın per-pane kuyruğunda,
  // paneRecycler.flushPendingReset) koşar. Pane bu arada tamamen kullanılabilir.
  entry.pendingReset = true;
  logLine(`pane reap ERTELENDİ (çıktı ekranda kalsın) paneId=${paneId} agent=${entry.agentId ?? '-'} why=${why}`);
  return true;
}

/**
 * Renderer'a istek + CEVAP. Kuyruk ilerletmenin gerçekten UYGULANDIĞINI bilmek şart:
 * `webContents.send` ateşle-unut olsaydı renderer yokken kayıt "ilerletildi" damgalanır
 * ve iş sonsuza dek kuyrukta kalırdı. Cevap gelmezse false → supervisor bir sonraki
 * tick'te YENİDEN dener (kayıt diskte, kayıp yok).
 */
const supervisorPending = new Map();
let supervisorReqSeq = 0;

function supervisorAskRenderer(channel, payload, timeoutMs = 8000) {
  const win = appWindow;
  if (!win || win.isDestroyed()) return Promise.resolve(false);
  const requestId = `sup-${++supervisorReqSeq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      supervisorPending.delete(requestId);
      resolve(false);
    }, timeoutMs);
    supervisorPending.set(requestId, { resolve, timer });
    try {
      win.webContents.send(channel, { requestId, ...payload });
    } catch {
      clearTimeout(timer);
      supervisorPending.delete(requestId);
      resolve(false);
    }
  });
}

// ADP-660 — GÖZETİMSİZ DEVAM plan limiti. `dlgsup:advance` supervisor'ın
// "sıradakini kendiliğinden başlat" kanalıdır = otopilot zinciri. Basic'te YALNIZ
// bu kanal kapalıdır; kayıt defterde KALIR (iş kaybolmaz) ve bildirim + lider
// uyandırma yolları çalışmaya devam eder → kullanıcı biteni görür, sırayı kendi
// başlatır. Pro/Ultra'da hiçbir fark yoktur. Kullanıcı yükseltirse bir sonraki
// tick'te kod değişmeden devam eder (karar her seferinde yeniden sorulur).
//
// Sayaç e2e içindir: "renderer cevap vermedi" ile "plan kapattı" AYNI `false`'a
// düşer; kapının GERÇEKTEN devrede olduğunu ayırt edebilmek için ölçülür.
let supervisorAdvanceBlocked = 0;

function supervisorPushRenderer(channel, payload) {
  if (channel === 'dlgsup:advance' && planDenial('autopilot')) {
    supervisorAdvanceBlocked++;
    return Promise.resolve(false);
  }
  return supervisorAskRenderer(channel, payload);
}

/** Pane exit / dispatch gibi olaylarda tick'i beklemeden kısa gecikmeyle süpür. */
function scheduleSupervisorSweep(delayMs = 1500) {
  if (!delegationSupervisor || supervisorSweepTimer) return;
  supervisorSweepTimer = setTimeout(() => {
    supervisorSweepTimer = null;
    void delegationSupervisor.sweep();
  }, delayMs);
  if (supervisorSweepTimer.unref) supervisorSweepTimer.unref();
}

/**
 * KILL-SWITCH — `CREWPANE_SUPERVISOR=0` gözcüyü tamamen kapatır (davranış ADP-659
 * öncesiyle birebir aynı olur). Bir P0 alt-sistemi kapatılabilir olmalı: saha
 * teşhisinde "bunu supervisor mı yapıyor?" sorusu tek env ile cevaplanır ve bir
 * regresyon şüphesinde ölçüm ALINABİLİR olur (bu ADP'nin baseline ölçümü de
 * bununla yapıldı). Kapalıyken tüm yüzey no-op'tur — çağıranlar dallanmaz.
 */
const SUPERVISOR_NULL = Object.freeze({
  record: () => null,
  settle: () => false,
  ack: () => 0,
  leaderStatus: () => ({ at: 0, records: [], untracked: [], disabled: true }),
  sweep: async () => {},
  start: () => {},
  stop: () => {},
  repairAfterRestart: () => 0,
  markExternalShutdown: () => [],
  externalShutdownNote: () => null,
  snapshot: () => ({ version: 0, records: {}, disabled: true }),
  config: () => ({ disabled: true }),
});

// ---------------------------------------------------------------------------
// KILL-GUARD-01 (madde 5) — DIŞARIDAN KAPATILDIK: uçuştaki işi DAMGALA.
// ---------------------------------------------------------------------------
// 08.09 gecesi uygulama `killall` ile iki kez kapandı. Kayıtlar çökme DEĞİL düzenli
// kapanış gösteriyordu — yani `before-quit` KOŞTU — ama hiçbir yerde "bu quit'i biz
// istemedik" bilgisi yoktu: kesilen üç worker'ın hangi kartlar olduğu ancak süpervizör
// defteri elle okunarak çıkarılabildi.
//
// Sinyal DİNLEYİCİSİ bu ayrımı kurar: `Cmd+Q` sinyal göndermez, `killall`/`pkill`/
// installer SIGTERM gönderir. Dinleyici KURULDUĞU AN Node'un varsayılan "anında öl"
// davranışını devralır → `app.quit()` çağırmak ZORUNLU (yoksa uygulama sinyale
// tepkisiz kalırdı, ki bu daha kötü bir arıza olurdu).
let externalShutdownSignal = null;
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  process.on(sig, () => {
    if (externalShutdownSignal) return; // ikinci sinyal: zaten çıkıyoruz
    externalShutdownSignal = sig;
    try { logLine(`⚠️ DIŞ KAPANIŞ: ${sig} alındı — uygulama kapanıyor (bu quit'i biz istemedik)`); } catch { /* log çıkışı tutmaz */ }
    try {
      const hits = (delegationSupervisor || SUPERVISOR_NULL).markExternalShutdown(sig);
      if (hits && hits.length) {
        const note = (delegationSupervisor || SUPERVISOR_NULL).externalShutdownNote(hits);
        if (note) logLine(note);
      }
    } catch { /* damga çıkışı ASLA geciktirmez */ }
    noteQuit('signal', sig);
    try { app.quit(); } catch { process.exit(143); }
  });
}

// ---------------------------------------------------------------------------
// ADP-845 — GÜNLÜK HEARTBEAT (ADP-805 §3.4). Çekirdek `telemetry/heartbeat.cjs`
// içinde ve saf; burada YALNIZ bağlantılar var.
//
// OPT-OUT ZİNCİRİ (üç kapı, hepsi kapatır):
//   1. settings.telemetryEnabled === false   → kullanıcının Ayarlar'daki anahtarı
//   2. CREWPANE_TELEMETRY=0                → kill-switch (destek/QA)
//   3. instance 'test'                       → e2e filosu dev DB'ye satır YAZMAZ
// ---------------------------------------------------------------------------
function telemetryEnabledNow() {
  if (crewpaneEnv.readEnv('TELEMETRY') === '0') return false;
  // e2e/test instance'ı BİLEREK sessiz: onlarca açılışın her biri gerçek
  // heartbeat satırı yazsaydı pano yalan söylerdi (updater'daki aynı karar).
  if (instancePaths.instanceId() === 'test' && crewpaneEnv.readEnv('TELEMETRY') !== '1') return false;
  return agentSettings.readSettings().telemetryEnabled !== false;
}

/** Kurulum kimliği + oturum sayacı. İlk çağrıda uuid üretir ve ayarlara yazar. */
function telemetryStateForSend() {
  const s = agentSettings.readSettings();
  const st = agentSettings.sanitizeTelemetryState(s.telemetryState);
  if (!st.installId) {
    st.installId = crypto.randomUUID();
    st.sessions = 1;
    agentSettings.writeSettings({ telemetryState: st });
  }
  return st;
}

let _heartbeat = null;
function heartbeat() {
  if (_heartbeat) return _heartbeat;
  _heartbeat = heartbeatMod.createHeartbeat({
    enabled: telemetryEnabledNow,
    target: () => {
      const t = rendererSupabaseTarget();
      return t && t.url && t.anonKey ? { url: t.url, anonKey: t.anonKey, schema: t.schema } : null;
    },
    // Board senkronu / mobil ofis / renderer ile AYNI kapı. ok:false → gönderim yok.
    accessToken: () => appDbTokenFor('telemetry:heartbeat'),
    state: telemetryStateForSend,
    saveState: (patch) => {
      const cur = agentSettings.sanitizeTelemetryState(agentSettings.readSettings().telemetryState);
      agentSettings.writeSettings({ telemetryState: { ...cur, ...patch } });
    },
    info: () => ({
      app: 'crewpane',
      appVersion: app.getVersion(),
      buildChannel: telemetryChannelMod.resolveChannel(), // buildChannel.cjs TEK GERÇEK
      updateChannel: currentUpdateChannel(),
      updaterMode: autoUpdaterRef ? 'updater' : 'notify',
      platform: process.platform,
      osRelease: os.release(),
      arch: process.arch,
      uiLocale: (app.getLocale() || '').slice(0, 5),
    }),
    log: (line) => logLine(line),
  });
  return _heartbeat;
}

/**
 * Sayaç artışı — ÇAĞRI YERLERİ İÇİN tek yüzey. Beyaz liste dışı anahtar düşer.
 *
 * OBS-01 — AKTİVASYON HUNİSİNİN MUSLUĞU BURASI. Görevin kuralı "yeni ölçüm
 * noktası icat etme" idi; huninin üç adımı da ZATEN bu fonksiyondan geçiyordu:
 *   pty:spawn → panes_opened / agents_spawned   ·   boardSync dispatch → delegations
 * Yani tek bir `if` satırı yerine tek bir MUSLUK eklendi ve huni, ölçtüğü
 * davranışla aynı kodu paylaşır: heartbeat sayacı ile PostHog hunisi ASLA
 * ayrışamaz (biri sayarken diğerinin saymadığı bir yol yoktur).
 */
const ANALYTICS_FUNNEL_EVENT = Object.freeze({
  panes_opened: 'pane_opened',
  agents_spawned: 'agent_spawned',
  delegations: 'delegation_started',
  tasks_created: 'task_created', // PH-01 — köprüdeki /telemetry/bump ile beslenir
});

/**
 * WIN-FIRSTRUN-01 (K5) — analitik `engine` özelliği için KAPALI KÜME dönüşümü.
 * Defterdeki motor kimliği aynen; ajan olmayan pane (kabuk) 'none'; bilinmeyen 'other'.
 * Şema (analyticsSchema.cjs) enum'u bu üçlüden başkasını zaten düşürür.
 */
function analyticsEngineOf(command) {
  if (!command) return 'none';
  const id = String(command);
  return engineRegistry.isRegisteredEngine(id) ? id : 'other';
}

function telemetryBump(key, by, props) {
  try { heartbeat().bump(key, by); } catch { /* telemetri asla çağıranı düşürmez */ }
  try {
    const event = ANALYTICS_FUNNEL_EVENT[key];
    if (!event) return; // memory_writes/voice_seconds → yalnız sayaç
    analyticsNow().track(event, { first_time: analyticsFirstTime(event), ...(props || {}) });
  } catch { /* analitik asla çağıranı düşürmez */ }
}

/** Açılışta bir kez: oturum sayacı + zamanlayıcılar. */
function startHeartbeat() {
  try {
    const s = agentSettings.readSettings();
    const st = agentSettings.sanitizeTelemetryState(s.telemetryState);
    agentSettings.writeSettings({
      telemetryState: { ...st, installId: st.installId || crypto.randomUUID(), sessions: (st.sessions || 0) + 1 },
    });
    heartbeat().start();
    if (!telemetryEnabledNow()) logLine('telemetry: heartbeat KAPALI (opt-out / kill-switch / test instance)');
  } catch (e) {
    logLine(`telemetry: heartbeat başlatılamadı (${e && e.message})`);
  }
}

/**
 * ADP-838 — supervisor'ın board yazarı (tek örnek, tembel kurulur).
 *
 * KILL-SWITCH: `CREWPANE_BOARD_SYNC=0` → board'a HİÇ yazılmaz (statü senkronu
 * ADP-838 öncesi gibi elle kalır). Bir statü şikâyetinde "bunu senkron mu yaptı?"
 * sorusu tek env ile cevaplanabilmeli.
 */
let _boardTaskSync = null;
function boardTaskSync() {
  if (_boardTaskSync) return _boardTaskSync;
  _boardTaskSync = boardTaskSyncMod.createBoardTaskSync({
    target: () => {
      const t = rendererSupabaseTarget();
      return t && t.url && t.anonKey ? { url: t.url, anonKey: t.anonKey, schema: t.schema } : null;
    },
    // `appdb:token` IPC'si / mobil ofis ile AYNI seatGate kaynağı. null → anon
    // (yerel/e2e `public` şeması bugünkü gibi çalışır).
    accessToken: () => appDbTokenFor('supervisor:board-sync'),
    enabled: () => crewpaneEnv.readEnv('BOARD_SYNC') !== '0',
    log: (line) => logLine(line),
  });
  return _boardTaskSync;
}

/** Supervisor'ı (bir kez) kur ve başlat. */
function ensureDelegationSupervisor() {
  if (delegationSupervisor) return delegationSupervisor;
  if (crewpaneEnv.readEnv('SUPERVISOR') === '0') {
    logLine('supervisor: KAPALI (CREWPANE_SUPERVISOR=0) — ADP-659 öncesi davranış');
    delegationSupervisor = SUPERVISOR_NULL;
    return delegationSupervisor;
  }
  const guard = supervisorFor('delegation-supervisor');
  const overrides = {};
  // e2e dikişi: gerçek koşuda 15sn tick beklemek yerine testin hızını kullan.
  const tickEnv = Number(process.env.CREWPANE_SUPERVISOR_TICK_MS);
  if (Number.isFinite(tickEnv) && tickEnv > 0) overrides.tickMs = tickEnv;
  const deliveryEnv = Number(process.env.CREWPANE_SUPERVISOR_DELIVERY_MS);
  if (Number.isFinite(deliveryEnv) && deliveryEnv > 0) overrides.deliveryCheckMs = deliveryEnv;
  const graceEnv = Number(process.env.CREWPANE_SUPERVISOR_PANE_GRACE_MS);
  if (Number.isFinite(graceEnv) && graceEnv >= 0) overrides.paneGoneGraceMs = graceEnv;
  const wakeEnv = Number(process.env.CREWPANE_SUPERVISOR_WAKE_ACK_MS);
  if (Number.isFinite(wakeEnv) && wakeEnv > 0) overrides.wakeAckWindowMs = wakeEnv;
  const reapEnv = Number(process.env.CREWPANE_SUPERVISOR_REAP_GRACE_MS);
  if (Number.isFinite(reapEnv) && reapEnv >= 0) overrides.reapGraceMs = reapEnv;
  // ADP-672 dikişleri: sessiz-worker eşiği (0 = kapalı) + uyandırma doğrulama penceresi.
  const idleEnv = Number(process.env.CREWPANE_SUPERVISOR_IDLE_MS);
  if (Number.isFinite(idleEnv) && idleEnv >= 0) overrides.idleMs = idleEnv;
  const wakeVerifyEnv = Number(process.env.CREWPANE_SUPERVISOR_WAKE_VERIFY_MS);
  if (Number.isFinite(wakeVerifyEnv) && wakeVerifyEnv >= 0) overrides.wakeVerifyMs = wakeVerifyEnv;
  // ADP-667 dikişleri: uyandırma TOPLAMA penceresi + tuş-sessizliği + örnekleme gecikmesi.
  const wakeCoalesceEnv = Number(process.env.CREWPANE_SUPERVISOR_WAKE_COALESCE_MS);
  if (Number.isFinite(wakeCoalesceEnv) && wakeCoalesceEnv >= 0) overrides.wakeCoalesceMs = wakeCoalesceEnv;
  const quietEnv = Number(process.env.CREWPANE_SUPERVISOR_INPUT_QUIET_MS);
  if (Number.isFinite(quietEnv) && quietEnv >= 0) overrides.wakeInputQuietMs = quietEnv;
  const sampleEnv = Number(process.env.CREWPANE_SUPERVISOR_SAMPLE_GAP_MS);
  if (Number.isFinite(sampleEnv) && sampleEnv >= 0) overrides.wakeSampleGapMs = sampleEnv;
  // ADP-692 dikişi: taslak kilidinin süresi (e2e otopilot senaryosunu dakikalarca bekletmemek için).
  const draftEnv = Number(process.env.CREWPANE_SUPERVISOR_DRAFT_GRACE_MS);
  if (Number.isFinite(draftEnv) && draftEnv >= 0) overrides.wakeDraftGraceMs = draftEnv;
  // ADP-667 kill-switch: lider-pane uyandırmasının sahibi renderer'a geri verilir.
  if (crewpaneEnv.readEnv('LEADER_WAKE_OWNER') === 'renderer') overrides.ownLeaderWake = false;

  delegationSupervisor = delegationSupervisorMod.createDelegationSupervisor({
    loadState: () => delegationSupervisorStore.loadState(crewpaneHome()),
    saveState: (s) => delegationSupervisorStore.saveState(s, crewpaneHome()),
    listPanes: supervisorListPanes,
    readPaneBuffer: (paneId) => {
      const e = ptys.get(paneId);
      return e ? e.buffer || '' : '';
    },
    writePane: (paneId, text) => {
      const e = ptys.get(paneId);
      if (!e) return false;
      try { e.child.write(text); return true; } catch { return false; }
    },
    reapPane: (paneId, why) => guard.run('reap', () => reapWorkerPane(paneId, why), false),
    fingerprint: supervisorFingerprint,
    // ADP-735 — kanıt VARLIK+YAŞ sondası. `fingerprint` baseline'a bağlıdır ve baseline
    // yanlış kökten alınmışsa sessizce "kanıt yok" der; bu sonda yalnız diske bakar.
    evidenceStat: (absPath) => {
      try {
        const s = fs.statSync(absPath);
        return { exists: s.isFile(), mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return { exists: false, mtimeMs: 0, size: 0 };
      }
    },
    // ADP-280 probu, main'den doğrudan: prompt worker'ın oturum defterinde mi?
    // checked=false → null (bakılamadı) — yanlış-undelivered YOK.
    // ENG-02 — motor farkında: claude=oturum jsonl, codex=rollout jsonl, diğer=null.
    // ADP-705 — GÜNCEL oturum (bkz. currentSessionId): `/clear` sonrası bayat id ile
    // okumak supervisor'ı da yanlış 'undelivered' üretmeye götürüyordu.
    transcriptHas: (rec) => {
      if (!rec.paneId || !rec.promptSignature) return null;
      return probeTranscriptVerdict(rec.paneId, String(rec.promptSignature));
    },
    // ADP-672 — uyandırma TESLİMAT doğrulaması. Aynı transcript probu, bu kez LİDER
    // pane'i için: "yazdığım mesaj liderin konuşmasına GERÇEKTEN girdi mi?".
    // Canlı Fury vakasında pty yazımı başarılıydı ama liderin oturum defterinde o
    // mesajın 0 eşleşmesi vardı (tur ortasında yutulmuş) — ve "teslim=ack" olduğu
    // için kayıt kapanmış, lider bir daha hiç uyandırılmamıştı.
    // ENG-02 — codex lider pane'i de doğrulanabilir: rollout defteri okunur.
    wakeVerifiable: (paneId) => probeTranscriptVerifiable(paneId),
    leaderTranscriptHas: (paneId, needle) => {
      if (!needle) return null;
      const e = ptys.get(paneId);
      // Lider pane'inde ADP-705 yeniden-çapalaması KOŞMAZ (tarihsel davranış): defterdeki
      // ham sessionId kullanılır. codex dalı zaten sessionId kullanmaz.
      return probeTranscriptVerdict(paneId, String(needle), { sessionId: e ? e.sessionId : null });
    },
    // ADP-538/545 kanalı — supervisor'ın kendi tespitleri de AYNI notify-log'a düşer,
    // yani liderin mevcut Monitor tail'i kod değişmeden supervisor'ı da duyar.
    // ADP-538/545 kanalı ADP-667'de KAPIDAN geçer: renderer aynı bitişi yazdıysa
    // ikinci satır düşer; aynı penceredeki bitişler tek satırda toplanır.
    notify: (evt) => notifyGate().admit(evt),
    // ADP-667 — idle-guard'ın 3. sinyali (son tuş basımı) + örnekleme gecikmesi.
    lastInputAt: (paneId) => {
      const e = ptys.get(paneId);
      return e && typeof e.lastInputAt === 'number' ? e.lastInputAt : null;
    },
    // ADP-692 — son GÖNDERİM (ENTER) damgası. Taslak-uçuşta hükmünün ikinci yarısı.
    lastSubmitAt: (paneId) => {
      const e = ptys.get(paneId);
      return e && typeof e.lastSubmitAt === 'number' ? e.lastSubmitAt : null;
    },
    // ADP-692 KANAL A — liderin `UserPromptSubmit` hook'unun bıraktığı makbuz. Hook AYRI
    // bir süreçtir; supervisor defterine yazsaydı main'in oku-değiştir-yaz döngüsüyle
    // yarışıp uçuştaki kayıtları silebilirdi → tek yönlü akış: hook makbuz yazar, main okur.
    readBriefingReceipts: () => {
      try {
        const p = path.join(crewpaneHome(), leaderBriefing.RECEIPT_FILE);
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        return null;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    pushRenderer: supervisorPushRenderer,
    // ADP-838 — BOARD STATÜ SENKRONU. Hedef İKİNCİ KEZ TÜRETİLMEZ (ADP-773 kuralı):
    // renderer'a giden `rendererSupabaseTarget()` ve `appdb:token` ile AYNI kaynak —
    // mobil ofis ve görev MCP'si de tam olarak bunları kullanır.
    boardSync: (input) => {
      // ADP-845 — KABA SAYAÇ: yalnız "kaç delegasyon dağıtıldı". Görev kodu,
      // başlık, departman ya da içerik HİÇBİRİ telemetriye gitmez.
      if (input && input.phase === 'dispatch') telemetryBump('delegations');
      return boardTaskSync().sync(input);
    },
    log: (line) => logLine(line),
    opts: overrides,
  });
  delegationSupervisor.start();
  return delegationSupervisor;
}

/**
 * ADP-428 — CREWPANE_RESUME_RETRY_DELAYS_MS="300000,900000" → [300000,900000];
 * unset/garbage → undefined (core defaults). Boş token'lar ÖNCE atılır:
 * Number('') === 0, yoksa unset env [0]'a dönüşüp retry'ı anında ateşler.
 */
function resumeRetryDelaysFromEnv() {
  const delays = (process.env.CREWPANE_RESUME_RETRY_DELAYS_MS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  return delays.length ? delays : undefined;
}

function startPtyResumeDaemonOnce() {
  if (ptyResumeDaemon || AUTORESUME_DISABLED || APP_PROBE || MODE === 'spike') return;
  if (LIMIT_RESUME_02) probeClaudeCliVersion(); // LIMIT-RESUME-02 — yedek sürüm kaynağı
  try {
    ptyResumeDaemon = resumePtyDaemon.startPtyResumeDaemon({
      getPanes: () => ptys,
      // LIMIT-RESUME-02 — ana bayrak + yedek sürüm kaynağı (pane transcript'i önce).
      limitResume02: LIMIT_RESUME_02,
      claudeVersion: () => claudeCliVersionCache,
      // Same write path the renderer's keystrokes take (pty:input above).
      writePane: (paneId, data) => {
        const entry = ptys.get(paneId);
        if (!entry) return false;
        try {
          entry.child.write(data);
          return true;
        } catch {
          return false;
        }
      },
      /* TOK-C (D-02 v2) — OTOMATİK DEVAM DA BÜTÇEYE TABİ.
         Bu daemon, insan başında yokken koşan tek şeydir: limit/çöküş sonrası
         motora "devam" yazar ve o an para harcanmaya devam eder. Fren buraya
         takılmazsa bütçe, kullanıcının EN ÇOK ihtiyaç duyduğu anda (gece,
         gözetimsiz) hiç çalışmamış olurdu.
         🔴 Yalnız METİN+ENTER yazımı (writeLine) sorar — SIFIR-JETONLU yoklama
         (RES-05 `probePane`, tek ESC baytı) sormaz: o para harcamaz ve
         engellenirse daemon pane'in canlılığını okuyamaz hâle gelirdi. */
      budgetGate: (paneId) => {
        const guard = enforcePaneBudget({ paneId, origin: spendGuard.SYSTEM_ORIGIN, source: 'resume-daemon' });
        return { allow: guard.allow, reason: guard.reason };
      },
      // Engine exited (pane left the Map) → relaunch on its prior session via the
      // SAME opts the ADP-192 restore path uses (agentId binding travels, ADR-005).
      // ADP-938 — `opts.engineProfileId` verildiğinde AYNI oturum BAŞKA HESAPLA açılır
      // (buildSpawn'ın ADP-936 `trusted.engineProfiles` boğazı çözer; renderer yol veremez).
      // Verilmezse çağrı bugünküyle bit-bit aynıdır.
      respawnPane: (entry, opts = {}) => {
        if (!appWindow || appWindow.isDestroyed()) return null;
        try {
          // HATA-12-B — MÜŞTERİNİN ASIL SENARYOSU BURASI: "limit doldu → motoru
          // değiştirdim". Pane limitte düşer, bu daemon onu DEFTERDEKİ motorla
          // diriltirdi ve sürüklenme geri gelirdi. Artık `respawnOptsFromEntry`
          // ajanın güncel motorunu okur (kendi iç çözümleyicisiyle).
          const drifted = paneEngineResolver.drift(entry);
          const base = respawnOptsFromEntry(entry, { where: 'limit-daemon' });
          if (engineProfiles.isProfileId(opts.engineProfileId)) {
            base.engineProfileId = opts.engineProfileId;
          }
          // PLAN-FIX-01 (F-4) — 'replace': limitli pane ÖNCE kapatılır (closePane, aşağıda),
          // bu spawn onun YERİNE gelir. Net artış yok → tavan sorulmaz (yanlış ret yok).
          base.spawnIntent = 'replace';
          const res = spawnPty(appWindow, base);
          // Sürüklenmede `--resume` KULLANILMADI (oturum eski motorundu). Daemon'ın
          // bildirimi "--resume <id> ile açıldı" derse TEŞHİS YANILTIR (HATA-12 §C
          // dersi) — sonucu işaretle, metni daemon düzeltsin.
          if (res && drifted) res.engineSwitched = drifted;
          return res;
        } catch (e) {
          logLine(`pty-resume respawn failed agent=${entry.agentId ?? '-'}: ${e.message}`);
          return null;
        }
      },
      // ADP-938 — geçiş bir re-spawn'dır: limitli pane ÖNCE kapanmalı, yoksa
      // "bir ajan = bir pane" (ADP-761) dedupe'u ikinci pane'i reddeder.
      closePane: (paneId) => {
        const entry = ptys.get(paneId);
        if (!entry) return false;
        killPane(paneId, entry, entry.agentId, 'engine account switch (ADP-938)');
        return true;
      },
      // ADP-938 — hesap havuzu ADP-936'nın deposundan gelir; burada YENİDEN
      // YAZILMAZ, ÇAĞRILIR. Ayar her okumada TAZE alınır: kullanıcı Ayarlar'dan
      // kapatınca bir sonraki limitte motor uyanmaz (uygulama yeniden başlamaz).
      //
      // 🪤 `home` AYRICA verilir ve daemon'ın `homedir`'ı DEĞİLDİR: kuyruk kökü
      // `crewpaneHome()` = $HOME, profil deposu ise `instancePaths.crewpaneHome()`
      // = ~/.crewpane (çok-hesapta accounts/u-…). Limit defteri profil deposunun
      // yanında yaşamalı, yoksa "hangi hesap limitli" bilgisi $HOME'da yetim kalırdı.
      engineAccounts: {
        home: instancePaths.crewpaneHome(),
        enabled: () => engineProfiles.autoSwitchOnLimit(instancePaths.crewpaneHome()),
        listProfiles: (engine) => engineProfiles.listProfiles(instancePaths.crewpaneHome(), engine),
        activeProfile: (engine) => engineProfiles.activeProfileId(instancePaths.crewpaneHome(), engine),
        setActive: (engine, profileId) =>
          engineProfiles.setActiveProfile(instancePaths.crewpaneHome(), engine, profileId),
      },
      homedir: crewpaneHome(),
      notifyLog: resolveResumeNotifyPath(),
      dryRun: process.env.CREWPANE_RESUME_DRYRUN === '1',
      pollMs: Number(process.env.CREWPANE_RESUME_POLL_MS) || undefined,
      verifyWindowMs: Number(process.env.CREWPANE_RESUME_VERIFY_MS) || undefined,
      // ADP-428 — resetAt güvenlik payı + verify-fail yeniden-deneme zinciri (env ile ayarlanabilir).
      resetBufferMs: Number(process.env.CREWPANE_RESUME_RESET_BUFFER_MS) || undefined,
      verifyMaxAttempts: Number(process.env.CREWPANE_RESUME_MAX_SEND_ATTEMPTS) || undefined,
      verifyRetryDelaysMs: resumeRetryDelaysFromEnv(),
      log: logLine,
      // Renderer toast/bell hook (ADP-042) — harmless when nothing listens.
      // ADP-844 — ADP-428 FAIL'i yalnız uygulama içine düşer (yapışkan kırmızı toast +
      // zil) ve resume notify LOG'una yazılır (resumeNotify.cjs) — pencere kapalıyken
      // de kalıcı iz orada. Ekran-dışı uyarı ihtiyacı mobil uygulamanın işidir.
      onEvent: (evt) => {
        if (appWindow && !appWindow.isDestroyed()) appWindow.webContents.send('resume:event', evt);
      },
    });
  } catch (e) {
    logLine(`pty-resume daemon failed to start: ${e.message}`);
    ptyResumeDaemon = null;
  }
}

// SEC-02 — TEMİZ ÇIKIŞ: kapanırken cihaz kirasını BIRAK.
//
// Neden çıkışı KISA SÜRE geciktirmeye değer: kira 15 dakikalıktır ve bırakılmazsa
// kullanıcının kendi makinesi 15 dakika boyunca koltuğu tutar. Dizüstünü kapatıp
// masaüstüne geçen tek kişi, kendi hesabında "başka cihazda aktif" duvarına
// toslardı — bu, tavanın KENDİSİNDEN çok şikâyet üretir.
//
// Neden ÇIKIŞ ASLA ASILMAZ (üç bağımsız kemer):
//   1. `releaseDeviceLease` kendi içinde `Promise.race` ile zaman aşımına uğrar
//   2. burada AYRICA bir failsafe zamanlayıcı `app.quit()` çağırır
//   3. bayrak tek seferliktir → ikinci `before-quit` doğrudan yıkıma gider
// Kira bırakılamazsa kayıp küçüktür (kira zaten dolacak); asılı kalan bir
// uygulama ise kullanıcının görebileceği en kötü hatadır.
let leaseReleaseAttempted = false;
app.on('before-quit', (event) => {
  if (!leaseReleaseAttempted && seatGate && !AUTOTEST) {
    leaseReleaseAttempted = true;
    const s = (() => { try { return seatGate.state(); } catch { return null; } })();
    // Yalnız gerçekten koltuk TUTAN kurulum için geciktir (giriş yapılmamışsa
    // ya da cihaz kimliği yoksa bırakılacak kira da yoktur).
    if (s && s.signedIn && s.device && s.device.device_id) {
      event.preventDefault();
      const failsafe = setTimeout(() => app.quit(), 2000);
      if (typeof failsafe.unref === 'function') failsafe.unref();
      seatGate.releaseDeviceLease({ timeoutMs: 1200 })
        .catch(() => {})
        .finally(() => { clearTimeout(failsafe); app.quit(); });
      return;
    }
  }
  app.isQuitting = true;
  // HATA-14 — FREN BURADA KURULUR: bu dal, kaynağı ne olursa olsun (X düğmesi,
  // menüden Çıkış, ⌘Q, oturum kapatma, güncelleme) HER GERÇEK kapanışın tek
  // ortak noktasıdır. Koltuk kirası dalı yukarıda quit'i bir kez erteler ve
  // kendisi yeniden quit çağırır; fren o gecikmeyi kesmesin diye ORAYA değil
  // BURAYA kurulur (kira bırakma penceresi 1200 ms + 2000 ms failsafe).
  armQuitBrake('quit');
  stopCrashWatchdog(); // ADP-475 — a deliberate quit isn't a crash; stop ticking
  // HATA-14 — KAPANIŞ HUNİSİ: adımlar quitFunnel.TEARDOWN_ORDER sözleşmesindeki
  // SIRAYLA koşar ve BİR ADIMIN ATMASI kalanları İPTAL ETMEZ. Eskiden bunlar düz
  // bir gövdeydi: `stopNextServer()` ya da `killAllPtys()` atarsa ondan sonraki
  // her şey (pane'ler, köprü) sessizce atlanır ve yetim kalırdı.
  const teardown = quitFunnel.runTeardown([
    // ADP-386 — ekran kuyruğu snapshot'tan ÖNCE yazılır ki write-ahead kopya da taşısın.
    { name: 'persist-screen-tails', run: () => persistScreenTails() },
    // TASK-MRDXOGZJDQLJG — write-ahead: copy the live-pane registry BEFORE any
    // teardown touches a pty. Whatever empties live-panes.json during this quit
    // (a kill race, a crash mid-teardown), the next launch can still restore from
    // the snapshot (restoreLivePanes fallback).
    { name: 'quit-snapshot', run: () => {
      const n = livePaneRegistry.writeQuitSnapshot(crewpaneHome());
      if (n) logLine(`quit: live-pane registry snapshot written (${n} pane(s))`);
    } },
    { name: 'global-shortcuts', run: () => globalShortcut.unregisterAll() },
    // ADP-limit — clear the pty resume timers before the ptys are torn down.
    // Referans ÖNCE bırakılır: eski gövdede `= null` bir try/catch'in DIŞINDAydı,
    // yani stop() atsa bile çalışıyordu. Sıra korunmazsa atan bir daemon geride
    // kalır ve ikinci quit onu yeniden durdurmaya kalkardı.
    { name: 'pty-resume-daemon', run: () => {
      const daemon = ptyResumeDaemon; ptyResumeDaemon = null;
      if (daemon) daemon.stop();
    } },
    // ADP-594 — stop the Responses→ChatCompletions adapter cleanly.
    { name: 'adapter', run: () => { if (adapter.isRunning()) adapter.stopAdapter(); } },
    // ADP-813 — yerel whisper sunucusu main'in ÇOCUĞU: kapanışta öldürülmezse yetim
    // kalır ve ~1.5 GB RAM'i tutmaya devam eder (bu makinede ağır iş yasağı var).
    { name: 'whisper-local', run: () => jarvisVoice.whisperLocal.stopServer() },
    // ADP-815 — kalıcı `claude` beyni de main'in ÇOCUĞU: aynı gerekçe (yetim süreç
    // + bellek). Boşta-kapanma zamanlayıcısı 10 dk'lık; quit onu beklemez.
    { name: 'jarvis-brain', run: () => jarvisVoice.stopBrain() },
    { name: 'next-server', run: () => stopNextServer() },
    { name: 'ptys', run: () => killAllPtys() },
    { name: 'delegation-bridge', run: () => {
      const bridge = delegationBridge; delegationBridge = null; // aynı gerekçe (yukarı)
      if (bridge) bridge.stop();
    } },
  ], { log: logLine });
  logLine(`[quit] kapanış hunisi: ${teardown.ran.length}/${teardown.ran.length + teardown.failed.length} adım tamam`
    + (teardown.failed.length ? ` — BAŞARISIZ: ${teardown.failed.map((f) => f.name).join(', ')}` : ''));
});

// ADP-334 — macOS'ta pencere kapanınca UYGULAMA YAŞAR (Dock'ta durur): mobil gateway
// main'de koştuğu için telefon ofisi görmeye DEVAM eder. Eskiden niyet buydu ama zincir
// tersini yapıyordu: stopNextServer() → next server 'exit' → `if (!app.isQuitting)
// app.quit()` → uygulama tamamen ölüyordu (gateway de onunla). Artık darwin'de sunucu
// AYAKTA bırakılır; Dock'tan geri açınca (activate) aynı URL anında yüklenir.
// Pane'ler yine reap edilir (preserve=true → restart-resume defteri korunur).
// ADP-905 — …ve pane'ler ARTIK reap EDİLMEZ. Buradaki koşulsuz `killAllPtys()`,
// hemen altındaki "darwin'de quit ATLA" kararıyla doğrudan çelişiyordu: uygulama
// yaşıyor, çocukları ölüyordu (12 ajan, code=129). Öldürme artık GERÇEKTEN çıkılan
// dalın içinde; `before-quit`'teki çağrı AYNEN durur (gerçek quit'te öldürmek doğru).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || AUTOTEST) {
    killAllPtys();
    stopNextServer();
    // HATA-14 — bu yol ARTIK tek giriş DEĞİL, YEDEK: ana pencere kapanışı
    // (createAppWindow → win.on('closed')) çıkışı zaten başlatır. Burası
    // yardımcı pencere HİÇ açılmamışken gelen (ve eskiden tek olan) yoldur;
    // fren ikisinde de AYNI tek-seferlik durumu paylaşır.
    armQuitBrake('window-all-closed');
    noteQuit('user-quit', 'window-all-closed');
    app.quit();
  } else {
    logLine(`ADP-905 window-all-closed: darwin — ${ptys.size} pane yaşamaya devam ediyor (quit YOK)`);
  }
});
