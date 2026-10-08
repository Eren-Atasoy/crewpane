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


const { app, BrowserWindow, ipcMain, shell, dialog, screen, globalShortcut, Notification, clipboard, nativeImage } = require('electron');

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');

const instancePaths = require('./src/config/instancePaths.cjs');
const supabaseTarget = require('./src/config/supabaseTarget.cjs'); // ADP-305 — test instance → e2e DB (kablo: encode/decodeArgv)
const backendTarget = require('./src/config/backendTarget.cjs'); // ADP-621 — kanal bazlı uygulama DB hedefi
const publicBackendEnv = require('./src/config/publicBackendEnv.cjs');
const appDbIdentity = require('./src/config/appDbIdentity.cjs'); // ADP-622 — app DB'ye hangi KİMLİKLE bağlanılır
const mixedTargetGuard = require('./src/config/mixedTargetGuard.cjs'); // ENV-01 — kimlik ↔ app DB karışımının reddi
const crewpaneEnv = require('./src/config/crewpaneEnv.cjs'); // ADP-244 Faz 3 — env ikizleri (tek türetme noktası)
const envProfileModule = require('./src/config/envProfile.cjs');
const { crewpaneIdConfig, gateOverrides } = require('./src/config/crewpaneId.cjs');
const singleInstanceLock = require('./src/core/singleInstanceLock.cjs');
const { renameWithRetrySync } = require('./platform/atomicWrite.cjs');
const safeStorageIdentity = require('./src/security/safeStorageIdentity.cjs');
const schemeOwnership = require('./src/core/schemeOwnership.cjs'); // ADP-719
const { appScheme, appSchemePrefix } = require('./src/core/appScheme.cjs');
const APP_URL_SCHEME = appScheme();
const APP_URL_PREFIX = appSchemePrefix();

// ── Bootstrap (Faz 3.1): Erken adımların sırayla çalıştırılması ──────────────
const { runBootstrap } = require('./src/main/bootstrap/index.js');
const { registerPrefsIpc, createSyncService } = require('./src/features/sync');
const { createMemoryService } = require('./src/features/memory');
const { createMobileService } = require('./src/features/mobile');
const { wireIpc: wireAppIpc } = require('./src/main/ipc');
const { createWindowManager } = require('./src/main/windows');
const { createNextServerManager } = require('./src/main/server');
const { createLifecycleManager, createStartupGate, createAppBootService } = require('./src/main/lifecycle');
const {
  createPaneRestoreService,
  createPtyResumeService,
  createPtyIsolationService,
  createPtySpawnService,
  createPaneControlService,
  createPaneDispatchService,
  createPaneQueryService,
  createPaneAskService,
  createPaneTranscriptService,
  createPaneBudgetService,
  PANE_ASK_MIRROR_MAX,
  REFRESH_SUBMIT_GAP_MS,
} = require('./src/features/terminal');
const { createDelegationSupervisorService, supervisorFingerprint } = require('./src/features/agents');
const { createJarvisConversationService } = require('./src/features/voice');
const { createBackendEnvService } = require('./src/features/services');
let windowManager = null;
let mobileService = null;

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
const modelDetect = require('./src/agents/modelDetect.cjs'); // ADP-526 — pane model chip (K1 spawn-anı + K2 çıktı teyidi)
const providers = require('./src/agents/providers.cjs'); // ADP-580 — codex custom AI providers (Groq/DeepSeek/Kimi)
const modelCatalog = require('./src/agents/modelCatalog.cjs'); // AGENT-MODEL-01 — motor başına model kataloğu (tek kaynak)
const adapter = require('./src/config/adapter.cjs'); // ADP-594 — Responses→ChatCompletions adapter for DeepSeek/Kimi (needsShim:true)
const groqShim = require('./src/voice/groqResponsesShim.cjs'); // PROV-01 — Groq /responses gövde temizleyici + kota hız-ayarı
const helperReaper = require('./src/core/helperReaper.cjs'); // ADP-727 — yardımcı süreç defteri + yetim toplayıcı
const installReset = require('./src/security/installReset.cjs'); // RESET-01 — kurulum sıfırlama ÇEKİRDEĞİ (tek silme boğazı)
const resetGate = require('./src/security/resetGate.cjs'); // RESET-03 — sıfırlamanın KARAR katmanı (saf; birim testli)
const quitFunnel = require('./src/core/quitFunnel.cjs'); // HATA-14 — tek kapanış hunisi (karar + fren + adım sırası)
const paneKill = require('./src/terminal/paneKill.cjs'); // TASK-MRDXOGZJDQLJG — quit-aware explicit pane kill
const resumePtyDaemon = require('./src/terminal/resumePtyDaemon.cjs'); // ADP-limit (ADR-007 Faz 4) — in-app pty auto-resume
const agentSettings = require('./src/agents/agentSettings.cjs'); // ADP-203 — user settings (~/.crewpane/settings.json)
const appI18n = require('./i18n/index.cjs'); // ADP-888 — ana sürecin ARAYÜZ DİLİ katmanı (diyalog/bildirim metinleri)
const updateCheck = require('./src/services/updateCheck.cjs'); // ADP-533 — Faz 1 güncelleme bildirimi (yalnız bildir + tarayıcıda indir)
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
const memoryEmbedInstall = require('./src/memory/memoryEmbedInstall.cjs'); // ADP-900 — ONAYLI gömme motoru kurulumu
const memoryEmbedder = require('./src/memory/memoryEmbedder.cjs'); // ADP-870 — gömme motorunun kullanılabilirlik raporu
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
const delegationSupervisorStore = require('./src/agents/delegationSupervisorStore.cjs');
// SUP-UI-01 — KUYRUK PANELİ. Yeni defter YOK: üç mevcut defteri (queue/supervisor/
// resume) + canlı pane listesini TEK tabloya çeviren SAF çekirdek. Metin taşımaz,
// yalnız kod döndürür (cümleyi renderer i18n'den kurar).
const queueBoard = require('./src/agents/queueBoard.cjs');
// SUP-UI-01 — limit-devam kuyruğunun deposu (ADP-087). Panel bu defteri de OKUR;
// yazan taraf hâlâ resume daemon'ıdır (bu dosyada tek çağrı `loadQueue`/`queuePath`).
const resumeQueueStore = require('./src/terminal/resumeQueue.cjs');
// ADP-715/845 — TELEMETRİ. İki ayrı iş, TEK opt-out kapısı:
//   telemetry.cjs → hata takibi (Sentry). ADP-845 K1: DSN/SDK YOK, yani bugün
//     `{enabled:false}` döner — ama kablo ARTIK DOĞRU DOSYADA. (ADP-805 §2.2'de
//     ölçüldü: init çağrısı silinmiş kök main.js'teydi, paketlenen giriş noktası
//     burasıydı → yayındaki üründe sıfır telemetri.)
//   heartbeat.cjs → "kim, hangi sürümde, ne zaman aktifti" (kendi Supabase'imiz).
const telemetryMod = require('./telemetry/telemetry.cjs');
const telemetryChannelMod = require('./telemetry/channel.cjs'); // build kanalı (prod|dev|test) TEK GERÇEK
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
const evidencePathMod = require('./src/services/evidencePath.cjs'); // ADP-735 — kanıt yolu: çok-adaylı kök çözümü (worker alt-projeye yazar)
const resultRootMod = require('./src/services/resultRoot.cjs'); // RES-IDX-01 — sonuç kökü görevin PROJESİNDEN (prompt + supervisor aynı cevabı alır)
const moduleGuard = require('./src/agents/moduleGuard.cjs'); // ADP-335 — modül hata sınırı (bir bug uygulamayı çökertmesin)
const paneControl = require('./src/terminal/paneControl.cjs'); // ADP-303 — lider pane kontrolü (kapsam + öz-koruma)
const teamScope = require('./src/agents/teamScope.cjs'); // ADP-717 — takım kapsamı: delege + yönetim TEK karar
const teamComposeCore = require('./src/agents/teamCompose.cjs'); // TC-01 — takım kurucu: rol süzgeci, tavanlar, onay jetonu, geri alma günlüğü
const workspaceOnboarding = require('./src/agents/workspaceOnboarding.cjs'); // ADP-232-C — ilk-açılış "çalışma alanı seç" çekirdeği
const workspaceSwitch = require('./src/agents/workspaceSwitch.cjs'); // ADP-232-B — canlı çalışma alanı geçişi (grandfather) çekirdeği
const engineCheck = require('./src/agents/engineCheck.cjs'); // ADP-463-B — setup sihirbazı motor/CLI probu (uyarı-only)
const ptyResizeGate = require('./src/terminal/ptyResizeGate.cjs'); // WIN-FIRSTRUN-01 K3 — ölü pty'ye resize gitmez (PROD-48)
const engineAuth = require('./src/agents/engineAuth.cjs'); // ADP-597 — abonelikle giriş (claude/codex oturumu Ayarlar'dan)
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
const nextServerPolicy = require('./src/config/nextServerPolicy.cjs'); // SMOKE-ISO-01 — Next beklenmedik ölürse: 1 kez kaldır, sonra kapat
const jarvisWidget = require('./src/voice/jarvisWidget.cjs'); // ADP-816 — taşınabilir ses widget'ı (saf karar katmanı)
const handOverlayContract = require('./src/hand/handOverlayContract.cjs'); // HAND-A1 — el kontrolü overlay sözleşmesi (saf karar katmanı)
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
// MCP-COST-01 — MCP cocuk sureclerinin envanteri + yetim bicmesi (ORPHAN-ELECTRON-01
// cekirdegini CAGIRIR, yeniden yazmaz) ve "otomatik acilmasin" isareti.
const mcpProcess = require('./src/mcp/mcpProcess.cjs');
const integrationAutostart = require('./src/mcp/integrationAutostart.cjs');
const { createSecretRedactor } = require('./src/security/secretRedactor.cjs'); // ADP-586 — log/ekran/notify maskeleme

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
let seatGate = null;

// ── ADP-201/621/622/723/741/773/ENV-01/02 — BACKEND VE SUPABASE ORTAM SERVİSİ (src/features/services/backendEnvService.js - Faz 3.6.41)
const backendEnvService = createBackendEnvService({
  repoRoot: REPO_ROOT,
  publicBackendEnv,
  backendTarget,
  appDbIdentity,
  envProfileModule,
  mixedTargetGuard,
  devChannel: require('./src/config/devChannel.cjs'),
  crewpaneIdConfig,
  instancePaths,
  getSeatGate: () => seatGate,
  seatDenial: (action) => seatDenial(action),
  logLine,
  envProfile: ENV_PROFILE,
  appUrlScheme: APP_URL_SCHEME,
  app,
  dialog,
});

function publicSupabaseEnv() {
  return backendEnvService.publicSupabaseEnv();
}
function appDbIdentityMode() {
  return backendEnvService.appDbIdentityMode();
}
function appDbTokenFor(action) {
  return backendEnvService.appDbTokenFor(action);
}
const mobileAppDbToken = () => backendEnvService.mobileAppDbToken();
function envLayerView() {
  return backendEnvService.envLayerView();
}
function logEnvBannerAndGuard() {
  return backendEnvService.logEnvBannerAndGuard();
}
function rendererSupabaseTarget() {
  return backendEnvService.rendererSupabaseTarget();
}

function hookScanHome() {
  return doctorService.hookScanHome();
}

function runDoctorNow() {
  return doctorService.runDoctorNow();
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
function parseFakeDescriptors(env) {
  if (env.CREWPANE_FAKE_ENGINE_DESCRIPTORS !== '1') return null;
  try {
    const raw = JSON.parse(String(env.CREWPANE_FAKE_ENGINE_DESCRIPTORS_JSON || '{}'));
    return (raw && typeof raw === 'object') ? raw : null;
  } catch {
    return null;
  }
}

function mergeFakeDescriptors(baseMap, raw) {
  let added = 0;
  for (const [id, d] of Object.entries(raw)) {
    if (!d || typeof d !== 'object' || baseMap[id]) continue; // gerçek kaydı EZMEZ
    const verdict = engineRegistry.validateRegistry({ [id]: d });
    if (!verdict || verdict.ok !== true) {
      const errs = (verdict && verdict.errors && verdict.errors[id]) || [];
      logLine(`engine:capabilityMatrix fake descriptor REDDEDİLDİ id=${id} errors=${errs.length}: ${errs.slice(0, 3).join(' · ')}`);
      continue;
    }
    baseMap[id] = d;
    added += 1;
  }
  return added;
}

function capabilityRegistry() {
  const raw = parseFakeDescriptors(process.env);
  if (!raw) return engineRegistry;
  const map = {};
  for (const id of engineRegistry.engineIds()) map[id] = engineRegistry.getEngine(id);
  const added = mergeFakeDescriptors(map, raw);
  if (!added) return engineRegistry;
  logLine(`engine:capabilityMatrix fake descriptors loaded count=${added}`);
  return engineRegistry.createRegistry(map);
}


function crewpaneHome() {
  return process.env.CREWPANE_HOME || os.homedir();
}

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

const {
  createFaultService,
  createTelemetryService,
  createAnnounceService,
  createChangelogService,
  createResetBootService,
  createMediaService,
  createDoctorService,
  createStartupSweepService,
  createAppLocaleService,
  createRebuildService,
} = require('./src/features/system');

// ── ADP-888/885/889 — UYGULAMA YERELLEŞTİRME SERVİSİ (src/features/system/appLocaleService.js - Faz 3.6.42)
const appLocaleService = createAppLocaleService({
  app,
  BrowserWindow,
  appI18n,
  agentSettings,
  logLine,
});
function applyAppLocale() { return appLocaleService.applyAppLocale(); }
function broadcastLocale() { return appLocaleService.broadcastLocale(); }
// ── ADP-533/553/620 — GÜNCELLEME SERVİSİ (src/features/update/updateService.js - Faz 3.6.14)
const { createUpdateService } = require('./src/features/update');

const updateService = createUpdateService({
  app,
  BrowserWindow,
  instancePaths,
  agentSettings,
  updateCheck,
  updateChannel,
  logLine,
  getSeatGate: () => seatGate,
  heartbeat: () => heartbeat(),
});

// ── ADP-675 — UYGULAMA-İÇİ DUYURU SERVİSİ (src/features/system/announceService.js - Faz 3.6.15a)
const announceService = createAnnounceService({
  app,
  BrowserWindow,
  instancePaths,
  agentSettings,
  announcements,
  currentUpdateChannel: () => updateService.currentUpdateChannel(),
  logLine,
});

// ── A-10 — UYGULAMA İÇİ "YENİLİKLER" SERVİSİ (src/features/system/changelogService.js - Faz 3.6.15b)
const changelogService = createChangelogService({
  BrowserWindow,
  instancePaths,
  changelogFeed,
  logLine,
});

// ── RESET-03 — KURULUM SIFIRLAMA & AÇILIŞ TEMİZLİK SERVİSİ (src/features/system/resetBootService.js - Faz 3.6.16)
const resetBootService = createResetBootService({
  app,
  dialog,
  appI18n,
  installReset,
  resetGate,
  helperReaper,
  analyticsNow: () => analyticsNow(),
});

// ── ADP-035/BOARD-IMG/FDBK — MEDYA, GEÇİCİ GÖRSEL & GÖREV EK DEPOSU (src/features/system/mediaService.js - Faz 3.6.17)
const mediaService = createMediaService({
  nativeImage,
  instancePaths,
  tempImageStore,
  attachmentStoreMod,
  feedbackBridgeMod,
  logLine,
  getBoundAccount: () => boundAccount,
  getLogPath: () => LOG_PATH,
});

// ── ADP-625/ADP-907 — SİSTEM TEŞHİS VE DOKTOR SERVİSİ (src/features/system/doctorService.js - Faz 3.6.18)
const doctorService = createDoctorService({
  firstRunDoctor,
  crewpaneEnv,
  instancePaths,
  os,
  getSeatGate: () => seatGate,
  getRendererSupabaseTarget: () => rendererSupabaseTarget(),
  getEnvLayerView: () => envLayerView(),
  getIdentityMode: () => appDbIdentityMode().mode,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  getWorkspaceStatus: () => agentSettings.configuredWorkspaceRootStatus(),
  getSecretBackend: () => secretBackendState.secretBackendState(),
  checkEngines: () => engineCheck.checkEngines(),
});

// ── ADP-307/900/727 — BAŞLANGIÇ SÜPÜRGE VE BAKIM SERVİSİ (src/features/system/startupSweepService.js - Faz 3.6.18)
const startupSweepService = createStartupSweepService({
  getPublicSupabaseEnv: () => publicSupabaseEnv(),
  agentSettings,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  getMemoryIndexer: () => memoryIndexer(),
  jarvisVoice,
  mcpProcess,
  helperReaper,
  logLine,
  autoIndexDelayMs: Number(process.env.CREWPANE_AUTO_INDEX_DELAY_MS || 15000),
});

// ── RESET-03/ENV-08/CRASH-R1 — AÇILIŞ KAPILARI & DOĞRULAMA (src/main/lifecycle/startupGate.js - Faz 3.6.19)
const startupGate = createStartupGate({
  app,
  dialog,
  singleInstanceGate,
  singleInstanceEarlyLog,
  resetGate,
  resetBootService,
  resetT: (k) => resetBootService.resetT(k),
  logEnvBannerAndGuard: () => logEnvBannerAndGuard(),
  applyAppLocale: () => applyAppLocale(),
  initLog: () => initLog(),
  logLine: (line) => logLine(line),
  crewpaneHome: () => crewpaneHome(),
  instancePaths,
  singleInstanceLock,
  translocationNotice: require('./src/core/translocationNotice.cjs'),
  crashJournal,
  i18n: require('./i18n/index.cjs'),
  logTarget: () => (typeof LOG_TARGET !== 'undefined' ? LOG_TARGET : null),
  logPath: () => (typeof LOG_PATH !== 'undefined' ? LOG_PATH : ''),
});

// ─── ADP-845/OBS-01/OBS-02 TELEMETRİ, PROVISIONING, HEARTBEAT & ANALİTİK (src/features/system/telemetryService.js - Faz 3.6.11)
const telemetryService = createTelemetryService({
  app,
  instancePaths,
  agentSettings,
  crewpaneEnv,
  logLine,
  getSeatGate: () => seatGate,
  appDbTokenFor: (action) => appDbTokenFor(action),
  rendererSupabaseTarget: () => rendererSupabaseTarget(),
  currentUpdateChannel: () => updateService.currentUpdateChannel(),
  isAutoUpdaterActive: () => updateService.isAutoUpdaterActive(),
  resolveCredential: (service) => credentialGate.resolveCredential(service, { rootDir: REPO_ROOT }),
  engineRegistry,
  safeStorage: require('electron').safeStorage,
});

// ── ADP-192/734/761/905 — PANE GERİ YÜKLEME VE KURTARMA SERVİSİ (src/features/terminal/paneRestoreService.js - Faz 3.6.20)
const paneRestoreService = createPaneRestoreService({
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
  reportModuleFault: (fault) => reportModuleFault(fault),
  planDenial: (feature, current, opts) => planDenial(feature, current, opts),
  spawnPty: (win, opts) => spawnPty(win, opts),
  getAppWindow: () => appWindow,
  ptys,
  isRestoreDisabled: () => RESTORE_DISABLED,
  isAppProbe: () => APP_PROBE,
  getMode: () => MODE,
});

// ── ADP-limit/428/545/938 — PTY OTOMATİK DEVAM VE BİLDİRİM SERVİSİ (src/features/terminal/ptyResumeService.js - Faz 3.6.21)
const ptyResumeService = createPtyResumeService({
  ptys,
  getAppWindow: () => appWindow,
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
  enforcePaneBudget: (opts) => enforcePaneBudget(opts),
  respawnOptsFromEntry: (entry, ctx) => respawnOptsFromEntry(entry, ctx),
  paneEngineResolver,
  spawnPty: (win, opts) => spawnPty(win, opts),
  killPane: (id, entry, aid, reason) => killPane(id, entry, aid, reason),
  isAutoresumeDisabled: () => AUTORESUME_DISABLED,
  isAppProbe: () => APP_PROBE,
  getMode: () => MODE,
  limitResume02: LIMIT_RESUME_02,
  probeClaudeCliVersion: () => probeClaudeCliVersion(),
  getClaudeCliVersionCache: () => claudeCliVersionCache,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  isPackaged: () => app.isPackaged,
  repoRoot: REPO_ROOT,
  getDepartmentDirs: () => agentSettings.readSettings().departmentDirs,
});

// ── B-01/B-02/ADP-761/ADP-896 — GÖREV İZOLASYONU VE PANE TEKİLLEŞTİRME (src/features/terminal/ptyIsolationService.js - Faz 3.6.23)
const ptyIsolationService = createPtyIsolationService({
  ptys,
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
  getWorkspaceRoot: () => agentWorkspaceRoot,
  readSettings: () => agentSettings.readSettings(),
  appI18n: { t: (k) => appI18n.t(k), getLocale: () => appI18n.getLocale() },
});

// ── ADP-003/013/694/852/WIN-01 — PTY PROCESS & EVENT YAŞAM DÖNGÜSÜ SERVİSİ (src/features/terminal/ptySpawnService.js - Faz 3.6.23b)
const ptySpawnService = createPtySpawnService({
  ptys,
  getAppWindow: () => appWindow,
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
  getWorkspaceRoot: () => agentWorkspaceRoot,
  readSettings: () => agentSettings.readSettings(),
  appI18n: { t: (k) => appI18n.t(k), getLocale: () => appI18n.getLocale() },
  planDenial: (feature, current, opts) => planDenial(feature, current, opts),
  dedupeSpawnForAgent: (opts, why) => dedupeSpawnForAgent(opts, why),
  resolveTaskWorktreeSync: (opts) => resolveTaskWorktreeSync(opts),
  liveIsolationFiles: () => liveIsolationFiles(),
  integrationResolverOrNull: () => integrationResolverOrNull(),
  codeIndexResolverOrNull: () => codeIndexResolverOrNull(),
  getDelegationBridge: () => delegationBridge,
  publicSupabaseEnv: () => publicSupabaseEnv(),
  engineKeyStore: () => engineKeyStore(),
  reportModuleFault: (fault) => reportModuleFault(fault),
  settleMemoryUsage: (opts) => settleMemoryUsage(opts),
  scheduleSupervisorSweep: (delayMs) => scheduleSupervisorSweep(delayMs),
  sendPaneEvent: (win, paneId, channel, payload) => sendPaneEvent(win, paneId, channel, payload),
  sessionAnchor: { forget: (id) => sessionAnchor.forget(id) },
  dispatchStore: { clear: (id) => dispatchStore.clear(id) },
  dispatchApplied: { delete: (id) => dispatchApplied.delete(id) },
  leaderRefreshState: { delete: (id) => (paneDispatchService && paneDispatchService.leaderRefreshState ? paneDispatchService.leaderRefreshState.delete(id) : undefined) },
  invalidateGitBranchCache: (dir) => invalidateGitBranchCache(dir),
  isQuitting: () => Boolean(app.isQuitting),
  isAutotest: () => AUTOTEST,
  isRestoreDisabled: () => RESTORE_DISABLED,
  hasMobileSubscribers: () => (typeof mobileService !== 'undefined' && mobileService && mobileService.mobileSubscribers ? mobileService.mobileSubscribers.size > 0 : false),
  emitMobileEvent: (evt) => emitMobileEvent(evt),
  getPaneAskRuntime: () => (typeof paneAskRuntime !== 'undefined' ? paneAskRuntime : null),
});

// ── ADP-303/717/737 — LİDER PANE KONTROLÜ & WORKER DÖNGÜSÜ SERVİSİ (src/features/terminal/paneControlService.js - Faz 3.6.26)
const paneControlService = createPaneControlService({
  ptys,
  getAppWindow: () => appWindow,
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
  getPtyResumeService: () => ptyResumeService,
  getJarvisConv: () => (typeof jarvisConv !== 'undefined' ? jarvisConv : null),
  appVersion: () => app.getVersion(),
  isQuitting: () => Boolean(app.isQuitting),
  engineRegistry,
  livePaneRegistry,
  paneControl,
  paneKill,
  agentRunner,
  teamScope,
  agentSettings,
});

function resetCommandFor(command) {
  return paneControlService.resetCommandFor(command);
}

function killPane(paneId, entry, agentId, why) {
  return paneControlService.killPane(paneId, entry, agentId, why);
}

function recycleWorkerPanes(agentId, mode = 'reset') {
  return paneControlService.recycleWorkerPanes(agentId, mode);
}

function callerScopeFor(leaderId, declared) {
  return paneControlService.callerScopeFor(leaderId, declared);
}

function authorizeTeamScope(opts = {}) {
  return paneControlService.authorizeTeamScope(opts);
}

async function authorizeTeamScopeInteractive(opts = {}) {
  return paneControlService.authorizeTeamScopeInteractive(opts);
}

function listPanesForControl(caller = {}) {
  return paneControlService.listPanesForControl(caller);
}

function closePanesForControl(payload = {}) {
  return paneControlService.closePanesForControl(payload);
}

function focusPaneForControl(paneId, caller = {}) {
  return paneControlService.focusPaneForControl(paneId, caller);
}

function analyticsNow() {
  return telemetryService.analyticsNow();
}
function analyticsFirstTime(marker) {
  return telemetryService.analyticsFirstTime(marker);
}
function analyticsEngineOf(command) {
  return telemetryService.analyticsEngineOf(command);
}
function telemetryProvisioning() {
  return telemetryService.telemetryProvisioning();
}
function telemetryTokenFor(service) {
  return telemetryService.telemetryTokenFor(service);
}
function heartbeat() {
  return telemetryService.heartbeat();
}
function telemetryBump(key, by, props) {
  return telemetryService.telemetryBump(key, by, props);
}
function startHeartbeat() {
  return telemetryService.startHeartbeat();
}

const faultService = createFaultService({
  app,
  getAppWindow: () => appWindow,
  logLine,
  telemetryEnvNow: () => telemetryService.telemetryEnvNow(),
  telemetryEnabledNow: () => telemetryService.telemetryEnabledNow(),
  appRoot: path.resolve(__dirname, '..'),
});

const moduleFaults = faultService.moduleFaults;
function obsReporterNow() {
  return faultService.obsReporterNow();
}
function reportModuleFault(fault, extra) {
  return faultService.reportModuleFault(fault, extra);
}
function supervisorFor(name) {
  return faultService.supervisorFor(name);
}

// ── ADP-659/660/667/672/838 — DELEGASYON SUPERVISOR SERVİSİ (src/features/agents/delegationSupervisorService.js - Faz 3.6.22)
const delegationSupervisorService = createDelegationSupervisorService({
  ptys,
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
  getAppWindow: () => appWindow,
  planDenial: (feat, count, opts) => planDenial(feat, count, opts),
  supervisorFor: (name) => supervisorFor(name),
  resolveWorkerNotifyPath: (dept) => resolveWorkerNotifyPath(dept),
  rendererSupabaseTarget: () => rendererSupabaseTarget(),
  appDbTokenFor: (action) => appDbTokenFor(action),
  telemetryBump: (key, by, props) => telemetryBump(key, by, props),
  resetCommandFor: (cmd) => resetCommandFor(cmd),
  maxTasksPerSession: 10,
  killPane: (id, entry, aid, why) => killPane(id, entry, aid, why),
  probeTranscriptVerdict: (paneId, needle, opts) => probeTranscriptVerdict(paneId, needle, opts),
  probeTranscriptVerifiable: (paneId) => probeTranscriptVerifiable(paneId),
});

// TEST-ONLY sentetik hata enjeksiyonu — hata sınırının GERÇEK uygulamada tuttuğunu kanıtlamak
// için (e2e). `CREWPANE_FAULT_INJECT=vt,gateway`. Env yoksa hiçbir etkisi yok.
const FAULT_INJECT = String(process.env.CREWPANE_FAULT_INJECT || '').split(',').map((s) => s.trim()).filter(Boolean);



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
// ─────────────────────────────────────────────────────────────────────────────
// ADP-705 — PANE⇄OTURUM ÇAPASI & ENG-02 — TESLİM PROBU (src/features/terminal/paneTranscriptService.js - Faz 3.6.43)
// ─────────────────────────────────────────────────────────────────────────────
const paneTranscriptService = createPaneTranscriptService({
  ptys,
  paneSessionAnchor,
  transcriptProbe,
  codexRolloutProbe,
  livePaneRegistry,
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
});
const sessionAnchor = paneTranscriptService.sessionAnchor;
function currentSessionId(paneId) { return paneTranscriptService.currentSessionId(paneId); }
function probeTranscriptContains(paneId, needle, o) { return paneTranscriptService.probeTranscriptContains(paneId, needle, o); }
function probeTranscriptVerdict(paneId, needle, o) { return paneTranscriptService.probeTranscriptVerdict(paneId, needle, o); }
function probeTranscriptVerifiable(paneId) { return paneTranscriptService.probeTranscriptVerifiable(paneId); }

// ─────────────────────────────────────────────────────────────────────────────
// TOK-C (D-02 v2) — HARCAMA FRENİ VE BÜTÇE SERVİSİ (src/features/terminal/paneBudgetService.js - Faz 3.6.43)
// ─────────────────────────────────────────────────────────────────────────────
const paneBudgetService = createPaneBudgetService({
  ptys,
  currentSessionId: (id) => currentSessionId(id),
  paneBudgetStore,
  tokenUsage,
  spendGuard,
  getAppWindow: () => appWindow,
  logLine: (line) => logLine(line),
});
function enforcePaneBudget(opts) { return paneBudgetService.enforcePaneBudget(opts); }

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

// ── LDR-F1 / ENT-F1 — PANE DISPATCH & LEADER REFRESH SERVICE (src/features/terminal/paneDispatchService.js - Faz 3.6.33)
const paneDispatchService = createPaneDispatchService({
  ptys,
  tokenUsage,
  tokenCost,
  dispatchPolicy,
  currentSessionId: (paneId) => currentSessionId(paneId),
  logLine: (line) => logLine(line),
  enforcePaneBudget: (opts) => enforcePaneBudget(opts),
  spendGuard,
  leaderRefreshPolicy,
  leaderRole,
  agentSettings,
  delegationSupervisorService,
  leaderComposer,
  transcriptProbe,
  secretRedactor,
  getAppWindow: () => appWindow,
  createDeliverPrompt,
  agentxDeliverMod,
  authorizeTeamScope: (opts) => authorizeTeamScope(opts),
  jarvisWidgetAlive: () => jarvisWidgetAlive(),
  labelTaskCodeOf: (label) => labelTaskCodeOf(label),
  sessionAnchor,
});

const dispatchStore = paneDispatchService.dispatchStore;
const dispatchApplied = paneDispatchService.dispatchApplied;
const dispatchSleep = paneDispatchService.dispatchSleep;
const deliverToPane = paneDispatchService.deliverToPane;
const agentxDeliverer = paneDispatchService.agentxDeliverer;

function paneDispatchDecisionFor(paneId, entry, opts = {}) {
  return paneDispatchService.paneDispatchDecisionFor(paneId, entry, opts);
}

function logDispatchDecision(paneId, decision, source) {
  return paneDispatchService.logDispatchDecision(paneId, decision, source);
}

function refreshPaneSession(paneId, opts) {
  return paneDispatchService.refreshPaneSession(paneId, opts);
}

function sampleLeaderGate(paneId) {
  return paneDispatchService.sampleLeaderGate(paneId);
}

function leaderRefreshViewFor(paneId, entry, decision) {
  return paneDispatchService.leaderRefreshViewFor(paneId, entry, decision);
}

function leaderRefreshTick(paneId, entry, decision) {
  return paneDispatchService.leaderRefreshTick(paneId, entry, decision);
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
// ── ADP-870/871/872/900/D-07 — HAFIZA VE ARAMA SERVİSİ (src/features/memory/memoryService.js - Faz 3.6.35)
const memoryService = createMemoryService({
  repoRoot: REPO_ROOT,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  getAppWindow: () => appWindow,
  logLine: (line) => logLine(line),
  agentRunner,
  agentSettings,
  transcriptProbe,
});

function memoryIndexer() {
  return memoryService.memoryIndexer();
}

function searchIndexer() {
  return memoryService.searchIndexer();
}

function memorySearcher() {
  return memoryService.memorySearcher();
}

function memoryEmbedInstaller() {
  return memoryService.memoryEmbedInstaller();
}

function settleMemoryUsage(opts) {
  return memoryService.settleMemoryUsage(opts);
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

// ADP-475 — crash instrumentation & main stall monitor (src/features/system/crashWatchdogService.js - Faz 3.6.9)
const { createCrashWatchdogService } = require('./src/features/system');

const crashWatchdogService = createCrashWatchdogService({
  app,
  BrowserWindow,
  ptys,
  logLine,
  resourceGovernor: () => resourceGovernor(),
  crashWatchdog,
});

function startCrashWatchdog() {
  return crashWatchdogService.startCrashWatchdog();
}

function stopCrashWatchdog() {
  return crashWatchdogService.stopCrashWatchdog();
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
  return ptyIsolationService.activeWorktreePaths();
}

async function prepareTaskIsolation(opts) {
  return ptyIsolationService.prepareTaskIsolation(opts);
}

async function preflightModelGate(opts, trusted) {
  return ptyIsolationService.preflightModelGate(opts, trusted);
}

function resolveTaskWorktreeSync(opts) {
  return ptyIsolationService.resolveTaskWorktreeSync(opts);
}

/**
 * @param {object} trustedExtra B-01: main'in ÇÖZDÜĞÜ görev/worktree bağı. Yalnız
 *   main tarafından üretilir (asenkron `ensure` sonucu ya da defter okuması);
 *   `opts` üzerinden ASLA gelmez — renderer'ın yol dayatması kapalıdır (G-1).
 */
function spawnPty(win, opts = {}, trustedExtra = null) {
  return ptySpawnService.spawnPty(win, opts, trustedExtra);
}

// ── ADP-013/386/905/MCP-COST-01 — PANE QUERY & LIFECYCLE SERVICE (src/features/terminal/paneQueryService.js - Faz 3.6.34)
const paneQueryService = createPaneQueryService({
  ptys,
  agentRunner,
  taskCodeMod,
  mcpProcess,
  paneKill,
  livePaneRegistry,
  crewpaneHome: () => crewpaneHome(),
  getPtyResumeService: () => ptyResumeService,
  paneViewState,
  paneDraft,
  paneBudgetStore,
  logLine: (line) => logLine(line),
  isQuitting: () => Boolean(app.isQuitting),
  isAutotest: () => AUTOTEST,
});

function labelTaskCodeOf(label) {
  return paneQueryService.labelTaskCodeOf(label);
}

function listPanes(win, department) {
  return paneQueryService.listPanes(win, department);
}

function killPaneExplicitAndCleanup(paneId) {
  return paneQueryService.killPaneExplicitAndCleanup(paneId);
}

function killPtysForWindow(winId) {
  return paneQueryService.killPtysForWindow(winId);
}

function keepPanesAliveOnWindowClose() {
  return paneQueryService.keepPanesAliveOnWindowClose();
}

function rebindOrphanPanes(win) {
  return paneQueryService.rebindOrphanPanes(win);
}

function liveAgentPaneCount() {
  return paneQueryService.liveAgentPaneCount();
}

function saveTempImage(payload) {
  return mediaService.saveTempImage(payload);
}

function ingestTaskAttachment(payload) {
  return mediaService.ingestTaskAttachment(payload);
}

function attachmentStore() {
  return mediaService.attachmentStore();
}

function feedbackBridge() {
  return mediaService.feedbackBridge();
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
// Kurulum ve boğazlar src/features/auth/service.js içinde modülerleştirildi (Faz 3.6.8).
const { createAuthService, createPlanLimitService, createApiKeyService, createAuthUrlService } = require('./src/features/auth');
// ADP-801 — bu süreç bir OTOMASYON oturumu mu (e2e / ajan koşumu)?
const { isAutomatedSession, automatedSessionReason } = require('./src/agents/automatedSession.cjs');
const IS_AUTOMATED_SESSION = isAutomatedSession(process.env);
const AUTOMATED_SESSION_REASON = automatedSessionReason(process.env);
// ADP-646 — vendor/müşteri YÜZEY kararı (tek yer)
const vendorSurface = require('./src/core/vendorSurface.cjs');
// ADP-614 — katman kataloğu (hangi entitlement CrewPane açar + etiketler).
const planCatalog = require('./src/config/planCatalog.cjs');
// ADP-660 — katman LİMİTİ kararı (Basic ⇄ Pro/Ultra).
const planLimits = require('./src/config/planLimits.cjs');
// ADP-703 — HESAP-KAPSAMLI YEREL DEPO (bağlama / geçiş)
const accountScope = require('./src/config/accountScope.cjs');
// SYNC-F1-6 — bulut senkronu
const syncBoot = require('./sync/syncBoot.cjs');
const prefsProjectorFactory = require('./prefs/prefsProjector.cjs');
const prefsWhitelist = require('./prefs/prefsWhitelist.cjs');
const syncSurface = require('./sync/syncIpc.cjs');
const memoryIndexDerive = require('./src/memory/memoryIndexDerive.cjs');

let boundAccount = null;

// ─── ADP-660/BL-01 — Katman Limitleri & Nudge Yönetimi (src/features/auth/planLimitService.js - Faz 3.6.13)
const planLimitService = createPlanLimitService({
  getSeatGate: () => seatGate,
  getAppWindow: () => appWindow,
  analyticsNow: () => analyticsNow(),
  logLine,
});

function pushPlanLimit(denial) {
  return planLimitService.pushPlanLimit(denial);
}
function planDenial(feature, current = 0, opts = {}) {
  return planLimitService.planDenial(feature, current, opts);
}
function workspacePlanDenial(root) {
  return planLimitService.workspacePlanDenial(root);
}
function planWaveLimit(requested) {
  return planLimitService.planWaveLimit(requested);
}
function rememberWorkspaceRoot(root) {
  return planLimitService.rememberWorkspaceRoot(root);
}

const authService = createAuthService({
  instancePaths,
  app,
  shell,
  logLine,
  getAppWindow: () => appWindow,
  pushPlanLimit: (denial) => pushPlanLimit(denial),
  integrityReportOnce: () => integrityReportOnce(),
  ptys,
  persistScreenTails: () => persistScreenTails(),
  livePaneRegistry,
  crewpaneHome: () => crewpaneHome(),
  killAllPtys: () => killAllPtys(),
  noteQuit: (r) => noteQuit(r),
  armQuitBrake: (r) => armQuitBrake(r),
  agentSettings,
  getResourceGovernor: () => _resourceGovernor,
  appI18n,
  testSeamDeps: {
    updateCheck,
    supervisorPushRenderer: (c, p) => delegationSupervisorService.supervisorPushRenderer(c, p),
    planWaveLimit: (r) => planWaveLimit(r),
    spawnPty: (win, opts) => spawnPty(win, opts),
    ptys,
    livePaneRegistry,
    crewpaneHome: () => crewpaneHome(),
    killPane: (id, e, aid, r) => killPane(id, e, aid, r),
    mobilePlanDenial: (opts) => mobilePlanDenial(opts),
    designPlanDenial: (opts) => designPlanDenial(opts),
    BrowserWindow,
    getRestoreSkippedByPlan: () => paneRestoreService.getRestoreSkippedByPlan(),
    getSupervisorAdvanceBlocked: () => delegationSupervisorService.getSupervisorAdvanceBlocked(),
  },
});

function initSeatGate() {
  seatGate = authService.initSeatGate();
  return seatGate;
}

function requireSeatOrThrow(action) {
  return authService.requireSeatOrThrow(action);
}

function seatDenial(action) {
  return authService.seatDenial(action);
}

async function bindAccountRoot(reason = 'boot') {
  const res = await authService.bindAccountRoot(reason);
  boundAccount = authService.getBoundAccount();
  return res;
}

function runningPaneSummary() {
  return authService.runningPaneSummary();
}

function signOutConfirmCopy(panes) {
  return authService.signOutConfirmCopy(panes);
}

function closePanesForSignOut() {
  return authService.closePanesForSignOut();
}

function relaunchApp(reason) {
  return authService.relaunchApp(reason);
}

function relaunchForAccountChange(nextKey, reason) {
  return authService.relaunchForAccountChange(nextKey, reason);
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

// ─── ADP-584/585/586 — Entegrasyon Merkezi çekirdeği (src/features/services/integrationService.js - Faz 3.6.12)
const {
  createIntegrationService,
  createBrowserService,
  createWorkspaceFileService,
  createCodeIndexService,
  createWorkspaceRootService,
} = require('./src/features/services');

const integrationService = createIntegrationService({
  instancePaths,
  safeStorage: require('electron').safeStorage,
  logLine,
  secretRedactor,
  credentialGate,
  repoRoot: REPO_ROOT,
  vendorSurface,
  engineAuth,
  getPtys: () => ptys,
  agentRunner,
  paneCapabilityMatrix,
});

function integrations() {
  return integrationService.integrations();
}
function engineKeyStore() {
  return integrationService.engineKeyStore();
}
async function integrationsStatusFor(req = {}) {
  return integrationService.integrationsStatusFor(req);
}
async function stampIntegrationVerified(service) {
  return integrationService.stampIntegrationVerified(service);
}
function integrationResolverOrNull() {
  return integrationService.integrationResolverOrNull();
}

// ── CIDX-1 — KOD İNDEKSİ SERVİSİ (src/features/services/codeIndexService.js - Faz 3.6.37)
const codeIndexService = createCodeIndexService({
  codeIndexStore,
  projectRepos,
  worktreeStore,
  agentSettings,
  crewpaneHome: () => crewpaneHome(),
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  logLine,
});
function codeIndexResolverOrNull() {
  return codeIndexService.codeIndexResolverOrNull();
}
function codeIndexRepoPath(slug) {
  return codeIndexService.codeIndexRepoPath(slug);
}
function codeIndexFreshness(repoPath, indexedSha) {
  return codeIndexService.codeIndexFreshness(repoPath, indexedSha);
}
const codeIndexJobs = codeIndexService.codeIndexJobs;

// ── ADP-719/801/833/954 — AUTH URL & DEEP LINK SERVICE (src/features/auth/authUrlService.js - Faz 3.6.36)
const authUrlService = createAuthUrlService({
  app,
  appUrlPrefix: APP_URL_PREFIX,
  getSeatGate: () => seatGate,
  isAutomatedSession: IS_AUTOMATED_SESSION,
  automatedSessionReason: AUTOMATED_SESSION_REASON,
  logLine: (line) => logLine(line),
});

let schemeVerdict = null;

function handleAuthUrl(url) {
  return authUrlService.handleAuthUrl(url);
}

function drainPendingAuthUrls() {
  return authUrlService.drainPendingAuthUrls();
}

function consumeArgvDeepLink(argv, source) {
  return authUrlService.consumeArgvDeepLink(argv, source);
}

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
const {
  gitBranchCache,
  GIT_BRANCH_TTL_MS,
  invalidateGitBranchCache,
} = require('./src/shared/utils');

// ── ADP-103/232-B/232-C/852 — ÇALIŞMA ALANI KÖK VE GEÇİŞ SERVİSİ (src/features/services/workspaceRootService.js - Faz 3.6.38)
const workspaceRootService = createWorkspaceRootService({
  app,
  BrowserWindow,
  workspaceOnboarding,
  workspaceSwitch,
  agentSettings,
  builtinSkills,
  skillEngineSync,
  invalidateGitBranchCache,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  setAgentWorkspaceRoot: (val) => { agentWorkspaceRoot = val; },
  workspacePlanDenial,
  rememberWorkspaceRoot,
  logLine,
  repoRoot: REPO_ROOT,
  forceFirstRun: FORCE_FIRST_RUN,
});

const activeRoots = workspaceRootService.activeRoots;
function switchWorkspaceRoot(rawRoot) {
  return workspaceRootService.switchWorkspaceRoot(rawRoot);
}
function reresolveWorkspaceRootAfterAccountBind() {
  return workspaceRootService.reresolveWorkspaceRootAfterAccountBind();
}
function seedBuiltinSkills(reason) {
  return workspaceRootService.seedBuiltinSkills(reason);
}
function syncSkillEngineViews(reason) {
  return workspaceRootService.syncSkillEngineViews(reason);
}

// ── ADP-103/108/109/437 — ÇALIŞMA ALANI DOSYA VE KALICILIK SERVİSİ (src/features/services/workspaceFileService.js - Faz 3.6.27)
const workspaceFileService = createWorkspaceFileService({
  activeRoots,
  getWorkspaceRoot: () => agentWorkspaceRoot,
  getUserDataPath: () => app.getPath('userData'),
  ptys,
  dialog,
  appI18n,
  fileMaxBytes: FILE_MAX_BYTES,
  logLine: (line) => logLine(line),
  renameWithRetry: renameWithRetrySync,
});

function withinActiveRoots(abs) {
  return workspaceFileService.withinActiveRoots(abs);
}

function resolveInRoots(p) {
  return workspaceFileService.resolveInRoots(p);
}

function readGitBranch(startDir) {
  return workspaceFileService.readGitBranch(startDir);
}

function resolveSearchRoot(p) {
  return workspaceFileService.resolveSearchRoot(p);
}

function displayPath(abs) {
  return workspaceFileService.displayPath(abs);
}

function readWorkspaceFile(p) {
  return workspaceFileService.readWorkspaceFile(p);
}

function writeWorkspaceFile(payload) {
  return workspaceFileService.writeWorkspaceFile(payload);
}

function listWorkspaceDir(dir) {
  return workspaceFileService.listWorkspaceDir(dir);
}

function openFolderDialog(win) {
  return workspaceFileService.openFolderDialog(win);
}

function allowPaneRoot(paneId) {
  return workspaceFileService.allowPaneRoot(paneId);
}

function rehydrateGrantedRoots() {
  return workspaceFileService.rehydrateGrantedRoots();
}

function readEditorState() {
  return workspaceFileService.readEditorState();
}

function writeEditorState(state) {
  return workspaceFileService.writeEditorState(state);
}

function readOfficeState() {
  return workspaceFileService.readOfficeState();
}

function writeOfficeState(state) {
  return workspaceFileService.writeOfficeState(state);
}

function readFeedbackSeen() {
  return workspaceFileService.readFeedbackSeen();
}

function writeFeedbackSeen(state) {
  return workspaceFileService.writeFeedbackSeen(state);
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
  return ptyIsolationService.liveIsolationFiles();
}

function dedupeSpawnForAgent(opts, why) {
  return ptyIsolationService.dedupeSpawnForAgent(opts, why);
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
// ── SKL-B3 / ADP-595 / AGENT-MODEL-01 — API Anahtarları ve Model Katalog Servisi (src/features/auth/apiKeyService.js - Faz 3.6.28)
const apiKeyService = createApiKeyService({
  engineRegistry,
  modelCatalog,
  providers,
  credentialGate,
  agentRunner,
  repoRoot: REPO_ROOT,
  logLine: (line) => logLine(line),
});

function engineModelCatalogPayload() {
  return apiKeyService.engineModelCatalogPayload();
}

function aiProvidersPayload(settings) {
  return apiKeyService.aiProvidersPayload(settings);
}

function appApiKeysPayload() {
  return apiKeyService.appApiKeysPayload();
}

function verifyAppApiKey(service) {
  return apiKeyService.verifyAppApiKey(service);
}


function buildPlatformAndWindowDeps() {
  return {
    ipcMain,
    app,
    shell,
    clipboard,
    nativeImage,
    dialog,
    screen,
    BrowserWindow,
    ptys,
    agentSettings,
    crewpaneHome,
    logLine,
    getAppWindow: () => appWindow,
    getAppBaseUrl: () => appBaseUrl,
    createAppWindow,
    openPopoutWindow,
    closePopoutWindow,
    listPopoutPanes,
    popoutWindowFor,
    openDesignWindow,
    closeDesignWindow,
    designWindowAlive,
    popoutPaneIdForWindow,
    windowManager,
    getWindowManager: () => windowManager,
    keepPanesAliveOnWindowClose,
    crashWatchdog,
    getAppUrlScheme: () => APP_URL_SCHEME,
    getAppUrlPrefix: () => APP_URL_PREFIX,
    mode: MODE,
    relaunchApp,
    rebuildAndRelaunch,
  };
}

function buildWorkspaceAndStorageDeps() {
  return {
    resolveInRoots,
    withinActiveRoots,
    displayPath,
    getAgentWorkspaceRoot: () => agentWorkspaceRoot,
    getWorkspaceRoot: () => agentWorkspaceRoot,
    supervisorFor,
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
    readOfficeState,
    writeOfficeState,
    workspacePlanDenial,
    workspaceOnboarding,
    rememberWorkspaceRoot,
    switchWorkspaceRoot: (root) => switchWorkspaceRoot(root),
    worktreeStore,
    projectRepos,
    agentWorkspaceRoot,
    mergeService,
    worktreeService,
    activeWorktreePaths,
    REPO_ROOT,
    codeIntel,
    gitBranchCache,
    GIT_BRANCH_TTL_MS,
    readGitBranch,
    resolveSearchRoot,
    branchName,
    codeIndexStore,
    codeIndexHealth,
    codeIndexRepoPath,
    codeIndexFreshness,
    codeIndexJobs,
    invalidateGitBranchCache,
  };
}

function buildMediaAndMemoryDeps() {
  return {
    clipboardImageRoute,
    saveTempImage,
    localSprites,
    pkgMgr: require('./src/agents/avatarPackageManager.cjs'),
    officePkg: require('./src/agents/officePackageManager.cjs'),
    imageStore: mediaService.imageStore,
    ingestTaskAttachment,
    attachmentStore,
    memoryGraph,
    memoryIndexer,
    memorySearcher,
    memoryEmbedder,
    memoryEmbedInstall,
    memoryEmbedInstaller,
    memoryRecall,
    secretRedactor,
    memoryTaskBlock,
    currentSessionId,
    paneContextScope,
    engineMemoryScope,
    searchIndexer: () => searchIndexer(),
    broadcastClipChanged,
    clipboardHistoryCore,
  };
}

function buildTerminalAndExecutionDeps() {
  return {
    listPanes,
    resourceGovernor,
    agentRunner,
    resourceGovernorModule,
    killPaneExplicitAndCleanup,
    dedupeSpawnForAgent,
    engineDelegation,
    prepareTaskIsolation,
    preflightModelGate,
    spawnPty,
    analyticsEngineOf,
    telemetryBump,
    enforcePaneBudget,
    spendGuard,
    leaderComposer,
    probeTranscriptContains,
    transcriptProbe,
    mobileTranscript,
    tokenUsage,
    paneTokenBudget,
    paneBudgetStore,
    paneDispatchDecisionFor,
    leaderRefreshTick,
    leaderRefreshViewFor,
    logDispatchDecision,
    refreshPaneSession,
    dispatchStore,
    modelDetect,
    paneAskRuntime,
    paneSessionAnchor,
    sessionAnchor,
    ptyResizeGate,
    acceptRecoverablePanes,
    tmuxWindows,
    paneViewState,
    broadcastPaneView,
    paneDraft,
    broadcastPaneDraft,
    getPaneAskRuntime: () => paneAskRuntime,
    getPtys: () => ptys,
    deliverToPane,
    dispatchSleep,
    authorizeTeamScopeInteractive,
    runningPaneSummary,
    closePanesForSignOut,
    resumePtyDaemon,
    livePaneRegistry,
    killPane,
    respawnOptsFromEntry,
    agentEngineMirror,
  };
}

function buildMobileAndSkillDeps() {
  return {
    announcements,
    announceStateForRenderer: () => announceService.announceStateForRenderer(),
    runAnnounceCheck: (trigger) => announceService.runAnnounceCheck(trigger),
    pushAnnounceState: () => announceService.pushAnnounceState(),
    announceHiddenThisSession: announceService.announceHiddenThisSession,
    getAnnounceState: () => announceService.getAnnounceState(),
    updateStateForRenderer: () => updateService.updateStateForRenderer(),
    runUpdateCheck: (trigger) => updateService.runUpdateCheck(trigger),
    updateLicenseGateNow: () => updateService.updateLicenseGateNow(),
    getAutoUpdaterRef: () => updateService.getAutoUpdaterRef(),
    getUpdateState: () => updateService.getUpdateState(),
    setUpdateState: (s) => updateService.setUpdateState(s),
    pushUpdateState: () => updateService.pushUpdateState(),
    updateCheck,
    noteQuit,
    runBrowserAction,
    browserGate,
    browserGuests,
    isOwnedGuest,
    guestOwners,
    setAppWindowGuest: (g) => { appWindowGuest = g; },
    getAppWindowGuest: () => appWindowGuest,
    agentGuests,
    lastUnownedGuest,
    integrations,
    planDenial,
    mcpProcess,
    integrationAutostart,
    telemetryProvisioning,
    sprintStore,
    resultRootMod,
    evidencePathMod,
    spawn,
    appI18n,
    notifyGate,
    getHandOverlayWindows: () => (windowManager ? windowManager.handOverlayWindows : new Map()),
    getHandOverlayPrefs: () => (windowManager ? windowManager.handOverlayPrefs() : { overlay: {} }),
    handOverlayAnyAlive: () => handOverlayAnyAlive(),
    closeHandOverlayWindows: (why) => closeHandOverlayWindows(why),
    feedHandOverlay: (raw) => feedHandOverlay(raw),
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
    getSyncRuntime: () => syncRuntime,
    getSyncIpcSurface: () => syncIpcSurface,
    mobilePending,
    mobileCommandPending,
    emitMobileEvent: (e) => emitMobileEvent(e),
    getMobileGateway: () => (mobileService ? mobileService.getMobileGateway() : null),
    mobileDeviceStore,
    mobilePlanDenial: (opts) => mobilePlanDenial(opts),
    startMobile: () => startMobile(),
    getMobileGatewayLastFailure: () => (mobileService ? mobileService.getMobileGatewayLastFailure() : null),
    mobileStartFailure: (ctx) => mobileStartFailure(ctx),
    mobileKillSwitch: () => mobileKillSwitch(),
    mobileProbe,
    requireSeatOrThrow,
    openJarvisWidgetWindow,
    closeJarvisWidgetWindow,
    jarvisWidgetAlive,
    jarvisWidget,
    broadcastJarvisWidget,
    jarvisWidgetPayload,
    moveJarvisWidget,
    showAppFromJarvisWidget,
    jarvisVoice,
    grokVoice,
    inputSim,
    screenCaptureMod,
    instancePaths,
    getJarvisConv: () => jarvisConv,
    agentxDeliverer,
    agentxBeamMod,
    agentxDraft,
    broadcastAgentxDraft,
    broadcastAgentxDraftConfirmed,
    skillCenter,
    skillEngineSync,
    skillApprove,
    skillAuthor,
    skillVersions,
    skillShare,
    builtinSkills,
    skillGuard,
    skillEngineView,
    getBoundAccount: () => boundAccount,
    syncSkillEngineViews,
    delegationQueueStore,
    delegationSupervisorStore,
    resumeQueueStore,
    queueBoard,
    ensureDelegationSupervisor,
    scheduleSupervisorSweep,
    supervisorPending,
    supervisorFingerprint,
    ensureComposeLedger,
    teamComposeCore,
    getComposeTransport: () => composeTransport,
    teamComposeRequest,
    composeFail,
    composeAutonomy,
    sampleLeaderGate,
  };
}

function buildSystemAuthAndEngineDeps() {
  return {
    getModuleFaults: () => moduleFaults,
    reportModuleFault,
    getLogPath: () => LOG_PATH,
    analyticsNow,
    analyticsSchema,
    analyticsFirstTime,
    telemetryTokenFor,
    credentialGate,
    stampIntegrationVerified,
    vendorSurface,
    telemetryMod,
    provisionStoreMod,
    telemetryChannelMod,
    getSeatGate: () => seatGate,
    gateOverrides,
    signOutConfirmCopy,
    accountScope,
    relaunchForAccountChange,
    schemeOwnership,
    getSchemeVerdict: () => schemeVerdict,
    setSchemeVerdict: (v) => { schemeVerdict = v; },
    isAutomatedSession: IS_AUTOMATED_SESSION,
    automatedSessionReason: AUTOMATED_SESSION_REASON,
    secretBackendState,
    handleAuthUrl,
    crewpaneIdConfig,
    verifyAppApiKey,
    planLimits,
    appDbTokenFor,
    resetContext: (log) => resetBootService.resetContext(log),
    installReset,
    resetGate,
    sendResetTelemetry: (o) => resetBootService.sendResetTelemetry(o),
    leaderRefreshPolicy,
    handOverlayContract,
    updateChannel,
    currentUpdateChannel: () => updateService.currentUpdateChannel(),
    aiProvidersPayload,
    engineModelCatalogPayload,
    appApiKeysPayload,
    engineCatalog,
    teamScope,
    browserTrustMod,
    broadcastLocale,
    prefsProjectNow,
    applyHandOverlaySettings,
    presetAdvisor,
    engineCheck,
    capabilityRegistry,
    paneCapabilityMatrix,
    engineOffering,
    engineLeadership,
    enginePlanned,
    engineAuth,
    engineProfiles,
    engineSwitch,
    limitDetect,
    getResetBootNotice: () => resetBootService.getResetBootNotice(),
    demoSitePath,
    runDoctorNow,
    firstRunDoctor,
    hookScanHome,
    changelogStateForRenderer: () => changelogService.changelogStateForRenderer(),
    runChangelogCheck: (trigger) => changelogService.runChangelogCheck(trigger),
    getChangelogState: () => changelogService.getChangelogState(),
    engineKeyStore: () => engineKeyStore(),
    engineLoginLedger,
    planCatalog,
  };
}

function wireIpc() {
  wireAppIpc({
    ...buildPlatformAndWindowDeps(),
    ...buildWorkspaceAndStorageDeps(),
    ...buildMediaAndMemoryDeps(),
    ...buildTerminalAndExecutionDeps(),
    ...buildMobileAndSkillDeps(),
    ...buildSystemAuthAndEngineDeps(),
  });
}

// ---------------------------------------------------------------------------
// Embedded Next server (dev/prod) — port management + ready-wait + clean kill.
// ---------------------------------------------------------------------------

const nextServerManager = createNextServerManager({
  app,
  spawn,
  repoRoot: REPO_ROOT,
  logLine,
  noteQuit,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  crewpaneHome,
  crewpaneEnv,
  helperReaper,
  nextServerPolicy,
  mappedProjectRootsForReports,
});

function standaloneDir() { return nextServerManager.standaloneDir(); }
function startNextServer(mode, opts) { return nextServerManager.startNextServer(mode, opts); }
function stopNextServer() { return nextServerManager.stopNextServer(); }

// ---------------------------------------------------------------------------
// ADP-139 (DOGFOOD Engel #2) — one-click "Rebuild & Relaunch" (src/features/system/rebuildService.js - Faz 3.6.42)
// ---------------------------------------------------------------------------
const rebuildService = createRebuildService({
  app,
  spawn,
  repoRoot: REPO_ROOT,
  logLine,
  relaunchApp,
});
function rebuildAndRelaunch(event) { return rebuildService.rebuildAndRelaunch(event); }

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

// ── ADP-095/333/341/394/396/399/884 — BAŞLIKLI TARAYICI OTOMASYONU SERVİSİ (src/features/services/browserService.js - Faz 3.6.24)
const browserService = createBrowserService({
  getAppWindow: () => appWindow,
  logLine,
  saveBrowserShot: (b64, tag) => saveBrowserShot(b64, tag),
  browserGuests,
  guestOwners,
  agentGuests,
  getAppWindowGuest: () => appWindowGuest,
  setAppWindowGuest: (g) => { appWindowGuest = g; },
  isOwnedGuest,
  lastUnownedGuest,
  incPendingAgentTabs: () => { pendingAgentTabs++; },
  decPendingAgentTabs: () => { if (pendingAgentTabs > 0) pendingAgentTabs--; },
  browserCdp,
  browserGateMod,
});

function browserGate() {
  return browserService.browserGate();
}

async function probeBrowserTarget(value) {
  return browserService.probeBrowserTarget(value);
}

async function runBrowserAction(value) {
  return browserService.runBrowserAction(value);
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
  setPanesRestored: (val) => { paneRestoreService.setPanesRestored(val); },
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
  ghostGuests: () => browserService.ghostGuests,
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

// ADP-095 — write a CDP base64 PNG screenshot to a temp file; return its path.
// WIN-IMG-01 — TTL YOK: aynı oturum deposundan geçer (ajanın kanıt-screenshot'ları
// da geç okunabilir; "5 dk yeter" varsayımı burada da geçersizdi).
function saveBrowserShot(base64, tag) {
  return mediaService.saveBrowserShot(base64, tag);
}

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
function designWindowAlive() { return windowManager.designWindowAlive(); }
function designPlanDenial({ notify = true } = {}) {
  return planDenial('designMode', 0, { notify });
}
function openDesignWindow() { return windowManager.openDesignWindow(); }
function closeDesignWindow() { return windowManager.closeDesignWindow(); }

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
function jarvisWidgetAlive() { return windowManager.jarvisWidgetAlive(); }
function jarvisWidgetPayload() { return windowManager.jarvisWidgetPayload(); }
function broadcastJarvisWidget() { return windowManager.broadcastJarvisWidget(); }
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
function handTuningConfig(prefs) { return windowManager.handTuningConfig(prefs); }
function handOverlayPrefs() { return windowManager.handOverlayPrefs(); }
function handOverlayAnyAlive() { return windowManager.handOverlayAnyAlive(); }
function closeHandOverlayWindows(reason) { return windowManager.closeHandOverlayWindows(reason); }
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
// ---------------------------------------------------------------------------
// HAND-A2 — "EL KONTROLÜ" Servisi (src/features/hand/service.js - Faz 3.6.6)
// ---------------------------------------------------------------------------
const { createHandService } = require('./src/features/hand');

const handService = createHandService({
  BrowserWindow,
  screen,
  systemPreferences: require('electron').systemPreferences,
  globalShortcut,
  getAppWindow: () => appWindow,
  openHandDetectWindow: () => windowManager.openHandDetectWindow(),
  handDetectAlive: () => windowManager.handDetectAlive(),
  feedHandOverlay: (raw) => feedHandOverlay(raw),
  handOverlayPrefs: () => handOverlayPrefs(),
  handTuningConfig: (prefs) => handTuningConfig(prefs),
  agentSettings,
  logLine,
});

const handControl = handService.handControl;
function startHandControl(opts) { return handService.startHandControl(opts); }
function stopHandControl(why) { return handService.stopHandControl(why); }
function handControlStatus() { return handService.handControlStatus(); }
function handControlLive() { return handService.handControlLive(); }
function finishPoseSampler() { return handService.finishPoseSampler(); }
function selectHandCamera(sel) { return handService.selectHandCamera(sel); }
function onHandDetectFrame(ev, p) { return handService.onHandDetectFrame(ev, p); }
function broadcastHandControlStatus() { return handService.broadcastHandControlStatus(); }
const handCameraPolicy = handService.handCameraPolicy;
function handHardwareCameras() { return handService.handHardwareCameras(); }
function handCameraPreference() { return handService.handCameraPreference(); }
function handDetectAlive() { return windowManager.handDetectAlive(); }
function scheduleHandControlWarmup(attempt = 0) { return windowManager.scheduleHandControlWarmup(attempt); }


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

function scheduleUpdateChecks() {
  updateService.scheduleUpdateChecks();
}

function scheduleAnnounceChecks() {
  announceService.scheduleAnnounceChecks();
}

function scheduleChangelogChecks() {
  changelogService.scheduleChangelogChecks();
}

function scheduleAutoMemoryIndex() {
  return startupSweepService.scheduleAutoMemoryIndex();
}

function scanE2EResidueAtStartup() {
  return startupSweepService.scanE2EResidueAtStartup();
}

app.whenReady().then(async () => {
  const gate = await startupGate.runStartupGate(process.argv);
  if (!gate.proceed) return;

  const appBootService = createAppBootService({
    engineCoerce,
    livePaneRegistry,
    offerRecoverablePanes,
    getAppWindow: () => appWindow,
    logLine,
    startCrashWatchdog,
    app,
    scanE2EResidueAtStartup,
    startupSweepService,
    ensureSpawnHelperExecutable,
    rehydrateGrantedRoots,
    crewpaneHome,
    repoRoot: REPO_ROOT,
    standaloneDir,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    schemeOwnership,
    appUrlScheme: APP_URL_SCHEME,
    isAutomatedSession: IS_AUTOMATED_SESSION,
    automatedSessionReason: AUTOMATED_SESSION_REASON,
    setSchemeVerdict: (v) => { schemeVerdict = v; },
    safeStorageIdentity,
    safeStorageScope: SAFE_STORAGE_SCOPE,
    secretBackendState,
    instanceHome: instancePaths.instanceHome(),
    initSeatGate,
    bindAccountRoot,
    reresolveWorkspaceRootAfterAccountBind,
    syncRuntime,
    prefsApplySoon,
    prefsProjectNow,
    seedBuiltinSkills,
    syncSkillEngineViews,
    consumeArgvDeepLink,
    drainPendingAuthUrls,
    wireIpc,
    startResourceGovernorSampling,
    createSpikeWindow,
    BrowserWindow,
    autotest: AUTOTEST,
    noteQuit,
    groqShim,
    providers,
    adapter,
    registerJarvisShortcut,
    scheduleHandControlWarmup,
    stopHandControl,
    scheduleUpdateChecks,
    startHeartbeat,
    scheduleAnnounceChecks,
    scheduleChangelogChecks,
    scheduleAutoMemoryIndex,
    memoryIndexerSingleton: memoryService.memoryIndexerSingleton,
    searchIndexSingleton: memoryService.searchIndexSingleton,
    jarvisVoice,
    notifyScreenshotsMovedOnce,
    runDoctorNow,
    doctorService,
    telemetryMod,
    agentSettings,
    telemetryProvisioning,
    obsReporterNow,
    telemetryChannelMod,
    analyticsNow,
    analyticsFirstTime,
    tamperSignals,
    faultInject: FAULT_INJECT,
    supervisorFor,
    externalUrl: process.env.CREWPANE_EXTERNAL_URL,
    mode: MODE,
    createAppWindow,
    startBridge,
    startMobile,
    startNextServer,
  });

  await appBootService.boot();
});
// ADP-303 / ADP-717 / ADP-737 — Lider pane kontrolü ve worker pane geri dönüşümü
// src/features/terminal/paneControlService.js içine taşındı (bkz: paneControlService).


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

// ── ADP-317 — JARVİS KONUŞMASI SERVİSİ (src/features/voice/jarvisConversationService.js - Faz 3.6.40)
const jarvisConversationMod = require('./src/voice/jarvisConversation.cjs');
const jarvisConversationService = createJarvisConversationService({
  jarvisConversationMod,
  logLine,
  BrowserWindow,
  emitMobileEvent: (event) => emitMobileEvent(event),
});
const jarvisConv = jarvisConversationService.conversation;

// ── ASK-CARD-01 (FB-1009) — LİDERİN KARAR SORUSU & PANE ASK SERVİSİ (src/features/terminal/paneAskService.js - Faz 3.6.40)
const paneAskService = createPaneAskService({
  paneAskMod,
  cleanPaneTail: (buf, max) => delegationBridgeMod.cleanPaneTail(buf, max),
  BrowserWindow,
  ptys,
  deliverToPane,
  getJarvisConv: () => jarvisConv,
  appI18n,
  logLine,
  submitGapMs: REFRESH_SUBMIT_GAP_MS,
  mirrorMax: PANE_ASK_MIRROR_MAX,
});
const paneAskRuntime = paneAskService.runtime;

mobileService = createMobileService({
  app,
  ptys,
  getAppWindow: () => appWindow,
  rendererSupabaseTarget,
  getMobileAppDbToken: () => mobileAppDbToken(),
  planDenial,
  delegationBridgeMod,
  secretRedactor,
  mobileTranscript,
  currentSessionId,
  agentRunner,
  delegationQueueStore,
  mobileOffice,
  jarvisVoice,
  mobileGatewayMod,
  mobileReports,
  mobileUploads,
  jarvisConv,
  mobileDeviceStore,
  logLine,
  repoRoot: REPO_ROOT,
  shellCommit: SHELL_COMMIT,
  standaloneDir,
});

const mobilePending = mobileService.mobilePending;
const mobileCommandPending = mobileService.mobileCommandPending;
function emitMobileEvent(event) { return mobileService.emitMobileEvent(event); }
function shotBridgeAgents() { return mobileService.shotBridgeAgents(); }
function shotBridgeSend(opts) { return mobileService.shotBridgeSend(opts); }
function mobilePlanDenial(opts) { return mobileService.mobilePlanDenial(opts); }
function startMobile() { return mobileService.startMobile(); }
function mobileStartFailure(err) { return mobileService.mobileStartFailure(err); }
function mobileKillSwitch() { return mobileService.mobileKillSwitch(); }

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
const syncService = createSyncService({
  agentSettings,
  getBoundAccount: () => boundAccount,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  publicSupabaseEnv,
  accountScope,
  getSeatGate: () => seatGate,
  appDbTokenFor,
  memoryIndexDerive,
  pushPlanLimit,
  logLine,
  broadcastLocale,
  getAppWindow: () => appWindow,
  getPopoutWindows: () => popoutWindows,
  prefsProjectorFactory,
  syncBoot,
  syncSurface,
});

const syncRuntime = syncService.syncRuntime;
const syncIpcSurface = syncService.syncIpcSurface;
function prefsProjector() { return syncService.prefsProjector(); }
function prefsProjectNow(reason) { return syncService.prefsProjectNow(reason); }
function prefsApplySoon() { return syncService.prefsApplySoon(); }

/** Tercih/kök/hedef değişti → motoru yeniden çöz (kapanışta ANINDA söker). */
// ── SYNC-F1-7 — TERCİH IPC'Sİ (renderer ekseni: localStorage) ────────────────
//
// Renderer'ın `localStorage`ı main'den OKUNAMAZ; bu yüzden düzen/sekme tercihleri
// iki yönlü bir IPC ile taşınır. Sınır DAR: renderer yalnız KENDİ eksenindeki
// (beyaz listede `renderer` kaynaklı) anahtarları yazabilir — `publishRenderer`
// gerisini düşürür, yani bir XSS yüzeyi buradan `locale`ı ya da bir sırrı
registerPrefsIpc({
  ipcMain,
  prefsProjector,
  prefsWhitelist,
  logLine,
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
// ── TC-01 — TAKIM KURUCU (src/features/agents/teamComposeService.js - Faz 3.6.7)
const { createTeamComposeService, createDelegationBridgeService } = require('./src/features/agents');

const teamComposeService = createTeamComposeService({
  teamComposeCore,
  teamScope,
  modelDetect,
  engineOffering,
  engineRegistry,
  planLimits,
  agentSettings,
  seatGate,
  callerScopeFor,
  ptys,
  getAppWindow: () => appWindow,
  logLine,
});

let composeTransport = null;
function ensureComposeLedger() { return teamComposeService.ensureComposeLedger(); }
function composeAutonomy() { return teamComposeService.composeAutonomy(); }
function composeFail(status, code, error, extra = {}) { return teamComposeService.composeFail(status, code, error, extra); }
function teamComposeRequest(req, transport) { return teamComposeService.teamComposeRequest(req, transport); }


// ── ADP-050 — DELEGASYON KÖPRÜSÜ SERVİSİ (src/features/agents/delegationBridgeService.js - Faz 3.6.39)
const delegationBridgeService = createDelegationBridgeService({
  delegationBridgeMod,
  crewpaneEnv,
  crewpanePaths,
  ensureDelegationSupervisor,
  resolveWindow: () => appWindow,
  logLine,
  ipcMain,
  runBrowserAction,
  probeBrowserTarget,
  getBrowserGate: () => browserGate(),
  recycleWorkerPanes,
  telemetryBump: (key) => telemetryBump(key),
  listPanesForControl,
  closePanesForControl,
  focusPaneForControl,
  authorizeTeamScopeInteractive: ({ action, leaderId, targetScope }) =>
    authorizeTeamScopeInteractive({ action, leaderId, targetScope }),
  teamComposeRequest: (payload, transport) => teamComposeRequest(payload, transport),
  setComposeTransport: (transport) => { composeTransport = transport; },
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  shotBridgeAgents,
  shotBridgeSend,
  ingestTaskAttachment: (req) => ingestTaskAttachment(req),
  notifyLog,
  resolveWorkerNotifyPath: (department) => resolveWorkerNotifyPath(department),
  appDbTokenFor: (source) => appDbTokenFor(source),
  integrationsStatusFor: (req) => integrationsStatusFor(req),
  seatDenial: (action) => seatDenial(action),
  planWaveLimit: (requested) => planWaveLimit(requested),
  deliverDictationToFocusedSurface: (text) => deliverDictationToFocusedSurface(text),
});

async function startBridge() {
  const bridge = await delegationBridgeService.startBridge();
  delegationBridge = bridge;
  return bridge;
}

/**
 * ADP-386 — pane'in VT ekranının son satırları (paneScreen defteri + canlı ekran).
 * Teardown'da livePaneRegistry'ye işlenir; restore yeni pty'nin replay buffer'ını
 * bununla tohumlar ki `claude --resume` sessizken pane SİMSİYAH kalmasın (kanıt:
 * pty:attach bufLen=0 + shot-1784059269700). Best-effort — hata null döner.
 */

/** ADP-386 — tüm canlı pane'lerin ekran kuyruğunu tek seferde registry'ye işle. */
function persistScreenTails() {
  return paneQueryService.persistScreenTails();
}

function killAllPtys() {
  return paneQueryService.killAllPtys();
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
const paneEngineResolver = paneRestoreService.paneEngineResolver;

function respawnOptsFromEntry(entry, ctx = {}) {
  return paneRestoreService.respawnOptsFromEntry(entry, ctx);
}

function offerRecoverablePanes(win, entries, meta = {}) {
  return paneRestoreService.offerRecoverablePanes(win, entries, meta);
}

function acceptRecoverablePanes(win) {
  return paneRestoreService.acceptRecoverablePanes(win);
}

function restoreLivePanes(win) {
  return paneRestoreService.restoreLivePanes(win);
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
  return ptyResumeService.resolveWorkerNotifyPath(department);
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

const supervisorPending = delegationSupervisorService.supervisorPending;

function scheduleSupervisorSweep(delayMs = 1500) {
  return delegationSupervisorService.scheduleSupervisorSweep(delayMs);
}

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
      const hits = delegationSupervisorService.markExternalShutdown(sig);
      if (hits && hits.length) {
        const note = delegationSupervisorService.externalShutdownNote(hits);
        if (note) logLine(note);
      }
    } catch { /* damga çıkışı ASLA geciktirmez */ }
    noteQuit('signal', sig);
    try { app.quit(); } catch { process.exit(143); }
  });
}

function ensureDelegationSupervisor() {
  return delegationSupervisorService.ensureDelegationSupervisor();
}

function notifyGate() {
  return delegationSupervisorService.notifyGate();
}

function startPtyResumeDaemonOnce() {
  return ptyResumeService.startPtyResumeDaemonOnce();
}

// ── SEC-02/HATA-14/ADP-905 — YAŞAM DÖNGÜSÜ & TEMİZ ÇIKIŞ YÖNETİCİSİ (src/main/lifecycle - Faz 3.6.19)
const lifecycleManager = createLifecycleManager({
  app,
  quitFunnel,
  crashJournal,
  instancePaths,
  getSeatGate: () => seatGate,
  isAutotest: AUTOTEST,
  crewpaneHome: () => crewpaneHome(),
  armQuitBrake: (label) => armQuitBrake(label),
  stopCrashWatchdog: () => stopCrashWatchdog(),
  killAllPtys: () => killAllPtys(),
  stopNextServer: () => stopNextServer(),
  noteQuit: (reason, signal) => noteQuit(reason, signal),
  getLivePaneCount: () => ptys.size,
  getQuitReason: () => quitReason,
  getQuitSignal: () => quitSignal,
  appStartedAt: APP_STARTED_AT,
  logLine,
  getTeardownSteps: () => [
    // ADP-386 — ekran kuyruğu snapshot'tan ÖNCE yazılır ki write-ahead kopya da taşısın.
    { name: 'persist-screen-tails', run: () => persistScreenTails() },
    // TASK-MRDXOGZJDQLJG — write-ahead: copy the live-pane registry BEFORE any
    // teardown touches a pty. Whatever empties live-panes.json during this quit
    // (a kill race, a crash mid-teardown), the next launch can still restore from
    // the snapshot (restoreLivePanes fallback).
    {
      name: 'quit-snapshot',
      run: () => {
        const n = livePaneRegistry.writeQuitSnapshot(crewpaneHome());
        if (n) logLine(`quit: live-pane registry snapshot written (${n} pane(s))`);
      },
    },
    { name: 'global-shortcuts', run: () => globalShortcut.unregisterAll() },
    // ADP-limit — clear the pty resume timers before the ptys are torn down.
    {
      name: 'pty-resume-daemon',
      run: () => ptyResumeService.stop(),
    },
    // ADP-594 — stop the Responses→ChatCompletions adapter cleanly.
    { name: 'adapter', run: () => { if (adapter.isRunning()) adapter.stopAdapter(); } },
    // ADP-813 — yerel whisper sunucusu main'in ÇOCUĞU: kapanışta öldürülmezse yetim kalır
    { name: 'whisper-local', run: () => jarvisVoice.whisperLocal.stopServer() },
    // ADP-815 — kalıcı `claude` beyni de main'in ÇOCUĞU
    { name: 'jarvis-brain', run: () => jarvisVoice.stopBrain() },
    { name: 'next-server', run: () => stopNextServer() },
    { name: 'ptys', run: () => killAllPtys() },
    {
      name: 'delegation-bridge',
      run: () => {
        delegationBridge = null;
        delegationBridgeService.stopBridge();
      },
    },
  ],
});
lifecycleManager.register();
