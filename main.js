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
const { registerPrefsIpc, createSyncService } = require('./src/features/sync');
const { createMobileService } = require('./src/features/mobile');
const { wireIpc: wireAppIpc } = require('./src/main/ipc');
const { createWindowManager } = require('./src/main/windows');
const { createNextServerManager } = require('./src/main/server');
const { createLifecycleManager, createStartupGate } = require('./src/main/lifecycle');
const { createPaneRestoreService, createPtyResumeService, createPtyIsolationService } = require('./src/features/terminal');
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
// SEN-F2 — pane çıkışı gürültü/arıza ayrımı (SEN-01 §4.4). Saf karar, ayrı dosyada: testli.
const paneExitClassifier = require('./telemetry/paneExit.cjs');
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
const { createAuthService, createPlanLimitService } = require('./src/features/auth');
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
const { createIntegrationService } = require('./src/features/services');

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

const {
  withinWorkspace: rawWithinWorkspace,
  withinActiveRoots: rawWithinActiveRoots,
  resolveInRoots: rawResolveInRoots,
  resolveSearchRoot: rawResolveSearchRoot,
  displayPath: rawDisplayPath,
  readWorkspaceFile: rawReadWorkspaceFile,
  writeWorkspaceFile: rawWriteWorkspaceFile,
  listWorkspaceDir: rawListWorkspaceDir,
  gitBranchCache,
  GIT_BRANCH_TTL_MS,
  invalidateGitBranchCache,
  readGitBranch: rawReadGitBranch,
} = require('./src/shared/utils');

function withinWorkspace(abs) {
  return rawWithinWorkspace(abs, agentWorkspaceRoot);
}

function withinActiveRoots(abs) {
  return rawWithinActiveRoots(abs, activeRoots);
}

function resolveInRoots(p) {
  return rawResolveInRoots(p, { workspaceRoot: agentWorkspaceRoot, activeRoots });
}

function readGitBranch(startDir) {
  return rawReadGitBranch(startDir, { activeRoots });
}

function resolveSearchRoot(p) {
  return rawResolveSearchRoot(p, { workspaceRoot: agentWorkspaceRoot, activeRoots });
}

function displayPath(abs) {
  return rawDisplayPath(abs, agentWorkspaceRoot);
}

function readWorkspaceFile(p) {
  return rawReadWorkspaceFile(p, {
    workspaceRoot: agentWorkspaceRoot,
    activeRoots,
    fileMaxBytes: FILE_MAX_BYTES,
    logLine,
  });
}

function writeWorkspaceFile(payload) {
  return rawWriteWorkspaceFile(payload, {
    workspaceRoot: agentWorkspaceRoot,
    activeRoots,
    fileMaxBytes: FILE_MAX_BYTES,
    logLine,
  });
}

function listWorkspaceDir(dir) {
  return rawListWorkspaceDir(dir, {
    workspaceRoot: agentWorkspaceRoot,
    activeRoots,
  });
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
  wireAppIpc({
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
    clipboardImageRoute,
    saveTempImage,
    announcements,
    announceStateForRenderer: () => announceService.announceStateForRenderer(),
    runAnnounceCheck: (trigger) => announceService.runAnnounceCheck(trigger),
    pushAnnounceState: () => announceService.pushAnnounceState(),
    announceHiddenThisSession: announceService.announceHiddenThisSession,
    getAnnounceState: () => announceService.getAnnounceState(),
    openPopoutWindow,
    closePopoutWindow,
    listPopoutPanes,
    popoutWindowFor,
    openDesignWindow,
    closeDesignWindow,
    designWindowAlive,
    listPanes,
    localSprites,
    pkgMgr: require('./src/agents/avatarPackageManager.cjs'),
    officePkg: require('./src/agents/officePackageManager.cjs'),
    readOfficeState,
    writeOfficeState,
    keepPanesAliveOnWindowClose,
    crashWatchdog,
    getAppWindow: () => appWindow,
    getAppBaseUrl: () => appBaseUrl,
    createAppWindow,
    resourceGovernor,
    agentRunner,
    resourceGovernorModule,
    killPaneExplicitAndCleanup,
    updateStateForRenderer: () => updateService.updateStateForRenderer(),
    runUpdateCheck: (trigger) => updateService.runUpdateCheck(trigger),
    updateLicenseGateNow: () => updateService.updateLicenseGateNow(),
    getAutoUpdaterRef: () => updateService.getAutoUpdaterRef(),
    getUpdateState: () => updateService.getUpdateState(),
    setUpdateState: (s) => updateService.setUpdateState(s),
    pushUpdateState: () => updateService.pushUpdateState(),
    updateCheck,
    noteQuit,
    worktreeStore,
    projectRepos,
    agentWorkspaceRoot,
    mergeService,
    worktreeService,
    invalidateGitBranchCache,
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
    activeWorktreePaths,
    evidencePathMod,
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
    spawn,
    appI18n,
    notifyGate,
    workspacePlanDenial,
    workspaceOnboarding,
    rememberWorkspaceRoot,
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
    popoutPaneIdForWindow,
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
    openJarvisWidgetWindow,
    closeJarvisWidgetWindow,
    jarvisWidgetAlive,
    windowManager,
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
    deliverToPane,
    dispatchSleep,
    authorizeTeamScopeInteractive,
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
    getAppUrlScheme: () => APP_URL_SCHEME,
    getAppUrlPrefix: () => APP_URL_PREFIX,
    gateOverrides,
    runningPaneSummary,
    signOutConfirmCopy,
    closePanesForSignOut,
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
    getPtys: () => ptys,
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
    resumePtyDaemon,
    livePaneRegistry,
    killPane,
    respawnOptsFromEntry,
    agentEngineMirror,
    mode: MODE,
    getResetBootNotice: () => resetBootService.getResetBootNotice(),
    rebuildAndRelaunch,
    demoSitePath,
    runDoctorNow,
    firstRunDoctor,
    hookScanHome,
    relaunchApp,
    changelogStateForRenderer: () => changelogService.changelogStateForRenderer(),
    runChangelogCheck: (trigger) => changelogService.runChangelogCheck(trigger),
    getChangelogState: () => changelogService.getChangelogState(),
    broadcastClipChanged,
    clipboardHistoryCore,
    engineKeyStore: () => engineKeyStore(),
    engineLoginLedger,
    planCatalog,
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
  return mediaService.saveBrowserShot(base64, tag);
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
function emergencyStopHandControl(why) { return handService.emergencyStopHandControl(why); }
function handControlStatus() { return handService.handControlStatus(); }
function handControlLive() { return handService.handControlLive(); }
function finishPoseSampler() { return handService.finishPoseSampler(); }
function selectHandCamera(sel) { return handService.selectHandCamera(sel); }
function onHandDetectFrame(ev, p) { return handService.onHandDetectFrame(ev, p); }
function broadcastHandControlStatus() { return handService.broadcastHandControlStatus(); }
const handCameraPolicy = handService.handCameraPolicy;
function handHardwareCameras() { return handService.handHardwareCameras(); }
function handCameraPreference() { return handService.handCameraPreference(); }
function handZoomFocusedSurface() { return handService.handZoomFocusedSurface(); }
function handZoomSend(p) { return handService.handZoomSend(p); }
function handDetectAlive() { return windowManager.handDetectAlive(); }
function openHandDetectWindow() { return windowManager.openHandDetectWindow(); }
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
  startupSweepService.scheduleMcpOrphanReap();
  startupSweepService.sweepOrphanHelpers({
    crewpaneHome,
    repoRoot: REPO_ROOT,
    standaloneDir,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
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
  // TTS-ORPHAN-01 · katman D — AÇILIŞTA YETİM `say` SÜPÜRGESİ.
  startupSweepService.sweepOrphanSayProcesses();
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
    .then((report) => logLine(doctorService.formatDoctorLog(report)))
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
  ptyResumeService.forgetPane(paneId);
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
      resumeDaemon: ptyResumeService.getDaemon(),
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

const mobileSubscribers = mobileService.mobileSubscribers;
const mobilePending = mobileService.mobilePending;
const mobileCommandPending = mobileService.mobileCommandPending;
function emitMobileEvent(event) { return mobileService.emitMobileEvent(event); }
function mobilePaneTail(paneId, opts) { return mobileService.mobilePaneTail(paneId, opts); }
function mobilePaneTranscript(paneId, opts) { return mobileService.mobilePaneTranscript(paneId, opts); }
function mobileListPanes() { return mobileService.mobileListPanes(); }
function mobileQueryRenderer(kind, params, timeoutMs) { return mobileService.mobileQueryRenderer(kind, params, timeoutMs); }
function mobileCommandRenderer(kind, payload) { return mobileService.mobileCommandRenderer(kind, payload); }
function mobileDelegationState() { return mobileService.mobileDelegationState(); }
function mobileOfficeSnapshot() { return mobileService.mobileOfficeSnapshot(); }
function shotBridgeAgents() { return mobileService.shotBridgeAgents(); }
function shotBridgeSend(opts) { return mobileService.shotBridgeSend(opts); }
function mobileTranscribe(payload) { return mobileService.mobileTranscribe(payload); }
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
function composePlanNote(seatCount) { return teamComposeService.composePlanNote(seatCount); }
function composeFail(status, code, error, extra = {}) { return teamComposeService.composeFail(status, code, error, extra); }
function teamComposeRequest(req, transport) { return teamComposeService.teamComposeRequest(req, transport); }
function applyEngineProposal(p, req, ledger, callRenderer) { return teamComposeService.applyEngineProposal(p, req, ledger, callRenderer); }


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
