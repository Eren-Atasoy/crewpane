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
const crypto = require('node:crypto'); // ADP-293 — mobil query requestId'leri
const { spawn, execFile } = require('node:child_process');

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
const { registerPrefsIpc, createSyncService } = require('./src/features/sync');
const { createMobileService } = require('./src/features/mobile');
const { wireIpc: wireAppIpc } = require('./src/main/ipc');
const { createWindowManager } = require('./src/main/windows');
const { createNextServerManager } = require('./src/main/server');
const { createLifecycleManager, createStartupGate, createAppBootService } = require('./src/main/lifecycle');
const { createPaneRestoreService, createPtyResumeService, createPtyIsolationService, createPtySpawnService, createPaneControlService } = require('./src/features/terminal');
const { createDelegationSupervisorService, supervisorFingerprint } = require('./src/features/agents');
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
let seatGate = null;

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
} = require('./src/features/system');
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
  leaderRefreshState: { delete: (id) => leaderRefreshState.delete(id) },
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
function calculateIdleMinutes(last) {
  if (!last || typeof last.atMs !== 'number') return null;
  return Math.floor(Math.max(0, Date.now() - last.atMs) / 60_000);
}

function calculateRelatedness(paneId, textOpt, th) {
  const nextText = typeof textOpt === 'string' ? textOpt : null;
  const cfg = th ? th.relatedness : null;
  return dispatchPolicy.relatedness({
    prevText: dispatchStore.lastText(paneId),
    nextText,
    corpus: dispatchStore.corpus(),
    cfg,
  });
}

function paneDispatchDecisionFor(paneId, entry, opts = {}) {
  const e = entry || ptys.get(paneId);
  if (!e) return null;
  try {
    const isStandard = e.command === 'claude' || e.command === 'codex';
    const engine = isStandard ? e.command : null;
    const usage = tokenUsage.usageForPane({
      paneId,
      engine: e.command || null,
      cwd: e.cwd || null,
      sessionId: currentSessionId(paneId),
      startedAt: e.startedAt || null,
    });
    const th = dispatchPolicy.thresholdsFrom(tokenCost.DEFAULT_PRICING, engine);
    const last = usage.lastRequest || null;
    const idleMinutes = calculateIdleMinutes(last);
    const rel = calculateRelatedness(paneId, opts.text, th);
    const decision = dispatchPolicy.decide({
      measured: usage.sessionFound === true,
      ctxTokens: last ? last.ctxTokens : null,
      idleMinutes,
      requests: typeof usage.sessionRequests === 'number' ? usage.sessionRequests : null,
      related: rel.related,
      thresholds: th,
    });
    return { ...decision, relatedness: rel, engine, applied: dispatchApplied.get(paneId) || null };
  } catch (err) {
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
function checkRefreshPreconditions(paneId) {
  const entry = ptys.get(paneId);
  if (!entry) return { ok: false, reason: 'no-pane', handoff: null };
  const guard = enforcePaneBudget({ paneId, entry, origin: spendGuard.SYSTEM_ORIGIN, source: 'dispatch-refresh' });
  if (!guard.allow) return { ok: false, reason: 'budget-paused', handoff: null, budget: guard.decision };
  const resetCmd = entry.command === 'claude' ? '/clear' : entry.command === 'codex' ? '/new' : null;
  if (!resetCmd) return { ok: false, reason: 'engine-not-resettable', handoff: null };
  return { ok: true, entry, resetCmd };
}

async function deliverPaneReset(paneId, entry, resetCmd) {
  try {
    entry.child.write('\x1b'); // yarım kalmış girdi satırını at (ADP-270 dersi)
    await dispatchSleep(REFRESH_ESC_GAP_MS);
    entry.child.write(resetCmd);
  } catch (err) {
    return { ok: false, reason: `reset-write-failed:${err.message}` };
  }
  try {
    const res = await deliverToPane(paneId, resetCmd, {
      mode: 'submit-only',
      submitGapMs: REFRESH_SUBMIT_GAP_MS,
      label: `sıfırlama(${resetCmd})`,
    });
    const resetDelivered = res.delivered;
    if (!resetDelivered) {
      logLine(
        `dispatch-policy SIFIRLAMA DOĞRULANAMADI paneId=${paneId} komut=${resetCmd} ` +
          `hüküm=${res.outcome} enter=${res.enters} — ` +
          `oturum SIFIRLANMAMIŞ olabilir (session-anchor bunu ayrıca ölçer)`,
      );
    }
    return { ok: true, resetDelivered };
  } catch (err) {
    return { ok: false, reason: `reset-write-failed:${err.message}` };
  }
}

function recordRefreshApplied(paneId, entry, { decision, source, handoffResult, resetDelivered }) {
  sessionAnchor.markReset(paneId);
  dispatchStore.clear(paneId);
  const applied = {
    atMs: Date.now(),
    code: decision ? decision.code : null,
    reasons: decision ? decision.reasons : [],
    handoff: handoffResult.ok,
    handoffReason: handoffResult.reason,
    resetDelivered,
    source: source || null,
  };
  dispatchApplied.set(paneId, applied);
  const handoffStr = handoffResult.ok
    ? `evet(${(handoffResult.text || '').length} karakter)`
    : `hayır(${handoffResult.reason})`;
  logLine(
    `dispatch-policy TAZELENDİ paneId=${paneId} kaynak=${source} sebep=${applied.code} devir=${handoffStr}`,
  );
  sendDispatchEvent({
    kind: 'refreshed',
    paneId,
    agentId: entry.agentId || null,
    decision: decision || null,
    applied,
  });
  return applied;
}

/**
 * Pane'in OTURUMUNU tazele: (isteğe bağlı) devir özeti + ESC + `/clear` + ENTER.
 * Süreç, kimlik (argv `--append-system-prompt`), MCP bağlantıları YAŞAR; yalnız
 * KONUŞMA sıfırlanır — paneRecycler'ın (ADP-266) tam olarak aynı mekanizması.
 */
async function refreshPaneSession(paneId, { handoff, decision, source, requireHandoff }) {
  const pre = checkRefreshPreconditions(paneId);
  if (!pre.ok) return pre;
  const { entry, resetCmd } = pre;

  let handoffResult = { ok: false, text: null, reason: 'not-requested' };
  if (handoff) handoffResult = await requestHandoffSummary(paneId, entry, decision);
  if (!ptys.has(paneId)) return { ok: false, reason: 'pane-gone', handoff: handoffResult };

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

  const resetRes = await deliverPaneReset(paneId, entry, resetCmd);
  if (!resetRes.ok) return { ok: false, reason: resetRes.reason, handoff: handoffResult };

  await dispatchSleep(REFRESH_GRACE_MS);
  const applied = recordRefreshApplied(paneId, entry, {
    decision,
    source,
    handoffResult,
    resetDelivered: resetRes.resetDelivered,
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
  return delegationSupervisorService.leaderInFlightCount(agentId);
}

/** Bu liderin AÇIK alt-görevleri (G5 geri yüklemesinin ikinci yarısı). */
function leaderOpenSubtasks(agentId) {
  return delegationSupervisorService.leaderOpenSubtasks(agentId);
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

const optVal = (val) => (val == null ? null : val);
const flagVal = (val) => val === true;

function formatPaneSnapshot(paneId, e, now) {
  const child = e.child;
  return {
    paneId,
    agentId: optVal(e.agentId),
    department: optVal(e.department),
    command: e.command,
    label: optVal(e.label),
    pid: e.pid,
    startedAt: e.startedAt,
    status: agentRunner.statusFor(e.lastDataAt, now),
    // ADP-108 — the pane's spawn cwd.
    cwd: optVal(e.cwd),
    // ADP-526 — pane'de koşan AI modelinin insan-okur etiketi (header chip'i).
    modelLabel: optVal(e.modelLabel),
    // ADP-565 — the pane'effective launch model id.
    launchModel: optVal(e.launchModel),
    // AGENT-MODEL-01 — pane'in EFEKTİF launch eforu.
    launchEffort: optVal(e.launchEffort),
    // ADP-595 — the pane'effective codex provider.
    launchProvider: optVal(e.launchProvider),
    // ACCT-FIX-01 — pane'in hesap profili KİMLİĞİ.
    engineProfileId: optVal(e.engineProfileId),
    // ADP-558 — the INVISIBLE half-work flag.
    stalled: flagVal(e.stalled),
    // ADP-502 — the stalled pane's evidence target.
    stallEvidence: optVal(e.stallEvidence),
    // ADP-667 — GECİKMELİ RESET bayrağı.
    pendingReset: flagVal(e.pendingReset),
    // ADP-532 — pty'nin gerçek boyutu.
    cols: typeof child?.cols === 'number' ? child.cols : null,
    rows: typeof child?.rows === 'number' ? child.rows : null,
    // ADP-694 — motor CLI bulunamadığı için açılmış KURULUM REHBERİ pane'i mi?
    engineMissing: optVal(e.engineMissing),
    engineInstall: optVal(e.engineInstallGuide),
    // ADP-852 — çalışma alanı seçilmemiş olduğu için açılmış REHBER pane'i mi?
    workspaceMissing: flagVal(e.workspaceMissing),
    // WIN-FIRSTRUN-01 (K1) — Windows kabuk rehberi pane'i mi?
    shellMissing: optVal(e.shellMissing),
    // ENG-OPENCODE-PROVIDER-01 — model kapısı rehber pane'i mi?
    modelGate: optVal(e.modelGate),
    // B-02 — PANE'İN KENDİ GÖREV BAĞI (§2.10)
    taskId: optVal(e.taskId),
    labelTaskCode: labelTaskCodeOf(e.label),
    // B-01 — pane defterindeki dal + izole ağaç.
    branch: optVal(e.branch),
    worktreePath: optVal(e.worktreePath),
    // ENG-10 — BU PANE'İN YETENEK BEYANI
    capabilities: optVal(e.capabilities),
  };
}

function paneMatchesFilter(entry, win, department) {
  if (win && entry.win.id !== win.id) return false;
  if (department && entry.department !== department) return false;
  return true;
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
    if (!paneMatchesFilter(e, win, department)) continue;
    out.push(formatPaneSnapshot(paneId, e, now));
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
    resumeDaemon: ptyResumeService.getDaemon(),
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
const { createAuthService, createPlanLimitService, createApiKeyService } = require('./src/features/auth');
const { crewpaneIdConfig, gateOverrides } = require('./src/config/crewpaneId.cjs');
// ADP-780-B — bu kopyanın URL şeması (prod: crewpane · dev: crewpane-dev · test: crewpane-test).
const { appScheme, appSchemePrefix } = require('./src/core/appScheme.cjs');
const APP_URL_SCHEME = appScheme();
const APP_URL_PREFIX = appSchemePrefix();
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
const { createIntegrationService, createBrowserService, createWorkspaceFileService } = require('./src/features/services');

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
function validateWorkspacePlan(rawRoot, log) {
  const planGate = workspacePlanDenial(rawRoot);
  if (!planGate) return null;
  log(`workspace:switch REDDEDİLDİ (plan): ${rawRoot} — ${planGate.tier} tavan=${planGate.limit}`);
  return {
    ok: false,
    reason: 'plan_limit',
    error: planGate.message,
    title: planGate.title,
    limit: planGate.limit,
    current: planGate.current,
    tier: planGate.tier,
    requiredTier: planGate.requiredTier,
    action: 'upgrade',
  };
}

function broadcastWorkspaceSwitch(resRoot, previous, grandfathered) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w._attachReportsWatcher?.(); } catch { /* window tearing down */ }
  }
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      if (!w.isDestroyed()) {
        w.webContents.send('workspace:changed', {
          root: resRoot,
          previous: previous ?? null,
          grandfathered: [...grandfathered],
          at: Date.now(),
        });
      }
    } catch { /* best-effort */ }
  }
}

function switchWorkspaceRoot(rawRoot) {
  const forbiddenPrefix = app.isPackaged ? process.resourcesPath : null;
  const planGate = validateWorkspacePlan(rawRoot, logLine);
  if (planGate) return planGate;

  const res = workspaceOnboarding.commitWorkspaceRoot(rawRoot, { forbiddenPrefix });
  if (!res.ok) {
    logLine(`workspace:switch REJECT ${rawRoot} → ${res.reason}`);
    return res;
  }
  rememberWorkspaceRoot(res.root);
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
  seedBuiltinSkills('workspace-switch');
  syncSkillEngineViews('workspace-switch');
  invalidateGitBranchCache();
  broadcastWorkspaceSwitch(res.root, previous, grandfatheredRoots);
  logLine(`workspace:switch ${previous ?? '-'} → ${res.root} (grandfathered ${grandfatheredRoots.size})`);
  return {
    ok: true,
    root: res.root,
    previous: previous ?? null,
    changed: true,
    grandfathered: [...grandfatheredRoots],
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

const {
  gitBranchCache,
  GIT_BRANCH_TTL_MS,
  invalidateGitBranchCache,
} = require('./src/shared/utils');

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
    memoryIndexerSingleton,
    searchIndexSingleton,
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
const { createTeamComposeService } = require('./src/features/agents');

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
        const bridge = delegationBridge;
        delegationBridge = null;
        if (bridge) bridge.stop();
      },
    },
  ],
});
lifecycleManager.register();
