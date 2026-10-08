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
const { crewpaneIdConfig } = require('./src/config/crewpaneId.cjs');
const singleInstanceLock = require('./src/core/singleInstanceLock.cjs');
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
const { createMainIpcWiring } = require('./src/main/ipc');
const { createWindowManager } = require('./src/main/windows');
const { createNextServerManager } = require('./src/main/server');
const { createLifecycleManager, createStartupGate, createAppBootService } = require('./src/main/lifecycle');
const { createTerminalServicesBundle } = require('./src/features/terminal');
const { createDelegationSupervisorService } = require('./src/features/agents');
const { createJarvisConversationService } = require('./src/features/voice');
const { createBackendEnvService } = require('./src/features/services');
let windowManager = null;
let mobileService = null;

function _handleFocusDeepLink(record) {
  try {
    if (authUrlService) {
      authUrlService.consumeArgvDeepLink(record && record.argv, 'focus-request');
    }
  } catch (e) {
    try { process.stderr.write(`[single-instance] deep-link error: ${e.message}\n`); } catch { /* ignore */ }
  }
}

const bootstrapCtx = {
  app,
  dialog,
  argv: process.argv,
  cwd: process.cwd(),
  handleFocusWindow: (record) => {
    _handleFocusDeepLink(record);
    try {
      let win = appWindow;
      if (!win || win.isDestroyed()) {
        if (!appBaseUrl) {
          process.stderr.write('[single-instance] odak isteği geldi ama pencere henüz yok (açılış sürüyor)\n');
          return;
        }
        logLine('[single-instance] odak isteği: ana pencere kapalıydı — yeniden açılıyor');
        if (windowManager) windowManager.createAppWindow(appBaseUrl);
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
const demoSitePath = require('./src/config/demoSitePath.cjs'); // DEMO-04 — tanıtım turunun örnek sitesinin yol boğazı
const jarvisVoice = require('./src/voice/jarvisVoice.js'); // ADP-121 (ADR-009) — voice core (STT/brain/TTS)
const engineCoerce = require('./src/agents/engineCoerce.cjs'); // ENG-05 — motor değeri kapısı (bilinmeyen → null + log)
const engineRegistry = require('./src/agents/engineRegistry.cjs'); // ENG-04/07 — motor descriptor defteri (reset komutu + yetenek beyanı)
const paneCapabilityMatrix = require('./src/terminal/paneCapabilityMatrix.cjs'); // ENG-10 — descriptor beyanı → kullanıcı-yüzü yetenek matrisi (rozetler)
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
const agentSettings = require('./src/agents/agentSettings.cjs'); // ADP-203 — user settings (~/.crewpane/settings.json)
const appI18n = require('./i18n/index.cjs'); // ADP-888 — ana sürecin ARAYÜZ DİLİ katmanı (diyalog/bildirim metinleri)
const updateCheck = require('./src/services/updateCheck.cjs'); // ADP-533 — Faz 1 güncelleme bildirimi (yalnız bildir + tarayıcıda indir)
const announcements = require('./src/services/announcements.cjs'); // ADP-675 — uygulama-içi duyuru feed'i (normalize + hedefleme)
const updateChannel = require('./src/services/updateChannel.cjs'); // ADP-620 — yayın kanalı (stable=müşteri | beta=önce biz)
const reportsWatcher = require('./src/services/reportsWatcher.cjs'); // ADP-298 — rapor dizinleri değişince renderer'a olay
const crewpanePaths = require('./src/config/crewpanePaths.cjs'); // ADP-233 — <workspace>/.crewpane/{tasks,results} yol sözleşmesi
// ADP-705 — pane⇄oturum çapası. `/clear` claude'da YENİ bir oturum (yeni uuid, yeni
// jsonl) açar ve bunu bize SÖYLEMEZ; pty defterindeki `--session-id` o an BAYAT olur.
// Bayat id ile okunan transcript "prompt yok" der → GERÇEKTEN ÇALIŞAN worker
// `undelivered` YALANIYLA öldürülürdü (2026-07-28'in beş vakasının ölçülmüş kök nedeni).
// B-01 (GIT-BACKBONE-SPEC) — görev ↔ branch ↔ proje omurgası (izole worktree).
const worktreeService = require('./src/services/worktreeService.cjs');
const mergeService = require('./src/services/mergeService.cjs');
const delegationQueueStore = require('./src/agents/delegationQueueStore.cjs'); // QUEUE-PERSIST — kuyruk+paused kalıcılığı
// ADP-659 — OTOPILOT SÜREKLİLİĞİ: uçuştaki delegasyonların MAIN-side kalıcı gözcüsü.
// Renderer'ın motoru (delegation.ts) efemerdir — reload/crash'te tüm nöbetleri ölür ve
// uçuştaki alt-görev hiçbir yerde kalıcı DEĞİLDİR (queue store yalnız queued+paused tutar).
// Bu ikili o boşluğu kapatır: defter diskte, tespit main'de, kuyruk lider olmadan ilerler.
// SUP-UI-01 — KUYRUK PANELİ. Yeni defter YOK: üç mevcut defteri (queue/supervisor/
// resume) + canlı pane listesini TEK tabloya çeviren SAF çekirdek. Metin taşımaz,
// yalnız kod döndürür (cümleyi renderer i18n'den kurar).
// SUP-UI-01 — limit-devam kuyruğunun deposu (ADP-087). Panel bu defteri de OKUR;
// yazan taraf hâlâ resume daemon'ıdır (bu dosyada tek çağrı `loadQueue`/`queuePath`).
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
const { createIntegrityService } = require('./src/security');
const integrityService = createIntegrityService({
  integrityCheck,
  tamperSignals,
  instancePaths,
  isCustomerBuild: () => require('./src/config/buildChannel.cjs').isCustomerBuild(),
  resourcesPath: process.resourcesPath || null,
  logLine: (line) => logLine(line),
  analyticsNow: () => telemetryService.analyticsNow(),
  obsReporterNow: () => (typeof faultService !== 'undefined' && faultService ? faultService.obsReporterNow() : null),
});
// INT-OBS-01 — tek jetondan otomatik kurulum (org bul → proje aç → anahtar çek →
// kanal başına yaz → doğrulama olayı) + sonucun şifreli defteri.
// ADP-692 — enjeksiyon kapısı (insan varlığı + composer hükmü); `pty:writeGuarded` bunu
// main'de, yazımla AYNI senkron blokta koşturur → araya tuş basımı GİREMEZ.
// LDR-F1 — LİDER TAZELEME KAPISI (saf çekirdek: kip · soğuma · backoff · rozet hükmü ·
// geri-yükleme metni). Karar YENİDEN ÜRETİLMEZ: `dispatchPolicy.decide` ne diyorsa odur,
// bu modül yalnız "o karar liderde ŞU AN uygulanabilir mi" sorusunu cevaplar (LDR-R1 §5).
// LDR-F1 — lider rol slug'larının TEK KAYNAĞI (agentRunner + renderer ile AYNI dosya).
// ENT-F1 — ana sürecin TESLİM-DOĞRULAMALI yazım primitifi. ENT-R1 §3 ölçtü:
// `writePromptToPane` (devir özeti) ve `/clear` dizisi metni yazıp 400 ms sonra
// `\r` basıyor ve HİÇBİR ŞEY doğrulamıyordu — canlı log'da 22 sıfırlamanın 4'ü
// "TUTMAMIŞ". Aynı primitif supervisor'ın iki yolunu da besliyor (tek uygulama).
// AXP-03 — Agent X'ten ajana prompt teslimi + makbuz (deliverToPane + transcript probu üstüne).
const stdioGuard = require('./src/core/stdioGuard.cjs'); // ADP-303 — EPIPE/dead-stream guard (no crash dialog)
const notifyLog = require('./src/services/notifyLog.cjs'); // ADP-538 — in-app worker completion → .agent-notifications DONE/FAIL satırı
const moduleGuard = require('./src/agents/moduleGuard.cjs'); // ADP-335 — modül hata sınırı (bir bug uygulamayı çökertmesin)
const teamComposeCore = require('./src/agents/teamCompose.cjs'); // TC-01 — takım kurucu: rol süzgeci, tavanlar, onay jetonu, geri alma günlüğü
const engineCheck = require('./src/agents/engineCheck.cjs'); // ADP-463-B — setup sihirbazı motor/CLI probu (uyarı-only)
const engineAuth = require('./src/agents/engineAuth.cjs'); // ADP-597 — abonelikle giriş (claude/codex oturumu Ayarlar'dan)
const firstRunDoctor = require('./src/agents/firstRunDoctor.cjs'); // ADP-625 — ilk açılış sağlık kontrolü (ADP-616 §5.4)
// LX-SAFESTORAGE-01 — sır arka ucunun TEK boğazı (ölç → hüküm → üç yüzey).
const secretBackendState = require('./src/security/secretBackendState.cjs');
const crashWatchdog = require('./src/core/crashWatchdog.cjs'); // ADP-475 — crash instrumentation + render-process-gone recovery core
const crashJournal = require('./src/core/crashJournal.cjs'); // CRASH-R1 — kapanış defteri (sebep + zaman + sinyal), açılışta geri okunur
const nextServerPolicy = require('./src/config/nextServerPolicy.cjs'); // SMOKE-ISO-01 — Next beklenmedik ölürse: 1 kez kaldır, sonra kapat
const jarvisWidget = require('./src/voice/jarvisWidget.cjs'); // ADP-816 — taşınabilir ses widget'ı (saf karar katmanı)
// ─── ADP-584/585/586 — Entegrasyon Merkezi (Dalga 0) ─────────────────────────
const integrationCatalog = require('./src/mcp/integrationCatalog.cjs'); // ADP-584/588 — servis şablonları (tek kaynak)
const credentialGate = require('./src/security/requireCredential.cjs'); // ADP-628 — anahtar çözümlemesinin TEK boğazı
// MCP-COST-01 — MCP cocuk sureclerinin envanteri + yetim bicmesi (ORPHAN-ELECTRON-01
// cekirdegini CAGIRIR, yeniden yazmaz) ve "otomatik acilmasin" isareti.
const mcpProcess = require('./src/mcp/mcpProcess.cjs');
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
  getSeatGate: () => (typeof authService !== 'undefined' && authService ? authService.getSeatGate() : null),
  seatDenial: (action) => (typeof authService !== 'undefined' && authService ? authService.seatDenial(action) : null),
  logLine,
  envProfile: ENV_PROFILE,
  appUrlScheme: APP_URL_SCHEME,
  app,
  dialog,
});

// BackendEnv and Doctor routines directly dispatched via backendEnvService and doctorService

// ADP-192 — restart-resume. Auto re-spawn the running agent panes on the next
// launch (unattended — see [[autopilot-auto-resume]]). Kill-switch: set
// CREWPANE_DISABLE_RESTORE=1. CREWPANE_HOME is a TEST SEAM (same spirit as
// CREWPANE_TMUX_BIN / CREWPANE_EXTERNAL_URL): it relocates ~/.crewpane so the
// e2e fixture can drive a real restart→resume on an isolated registry file.
const RESTORE_DISABLED = process.env.CREWPANE_DISABLE_RESTORE === '1';

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
    faultService.reportModuleFault({
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
  createRebuildService,
  createSystemServicesBundle,
} = require('./src/features/system');

// ── ADP-SYS-BUNDLE — SİSTEM SERVİSLERİ PAKETİ (src/features/system/systemServicesBundle.js - Faz 3.6.60)
const {
  appLocaleService,
  updateService,
  announceService,
  changelogService,
  resetBootService,
  mediaService,
  doctorService,
  startupSweepService,
  telemetryService,
} = createSystemServicesBundle({
  app,
  BrowserWindow,
  dialog,
  nativeImage,
  logLine,
  getSeatGate: () => (typeof authService !== 'undefined' && authService ? authService.getSeatGate() : null),
  getBoundAccount: () => (typeof authService !== 'undefined' && authService ? authService.getBoundAccount() : null),
  backendEnvService,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  getMemoryIndexer: () => (typeof memoryService !== 'undefined' && memoryService ? memoryService.memoryIndexer() : null),
  getLogPath: () => LOG_PATH,
  repoRoot: REPO_ROOT,
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
  logEnvBannerAndGuard: () => backendEnvService.logEnvBannerAndGuard(),
  applyAppLocale: () => appLocaleService.applyAppLocale(),
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

const livePaneRegistry = require('./src/agents/livePaneRegistry.cjs'); // ADP-192 — restart-resume registry
const transcriptProbe = require('./src/services/transcriptProbe.cjs'); // ADP-280 — teslim-doğrulama transcript probu
const teamScope = require('./src/agents/teamScope.cjs'); // ADP-717 — takım kapsamı: delege + yönetim TEK karar

const ptys = new Map();

// ── ADP-TERM-BUNDLE — TERMİNAL & PTY SERVİSLERİ PAKETİ (src/features/terminal/terminalServicesBundle.js - Faz 3.6.61)
const {
  paneRestoreService,
  ptyResumeService,
  ptyIsolationService,
  ptySpawnService,
  paneControlService,
  paneTranscriptService,
  paneBudgetService,
  paneDispatchService,
  paneAskService,
  paneQueryService,
} = createTerminalServicesBundle({
  ptys,
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
  getAppWindow: () => appWindow,
  reportModuleFault: (fault) => (typeof faultService !== 'undefined' && faultService ? faultService.reportModuleFault(fault) : null),
  planLimitService: () => (typeof planLimitService !== 'undefined' ? planLimitService : null),
  isRestoreDisabled: () => RESTORE_DISABLED,
  isAppProbe: () => APP_PROBE,
  getMode: () => MODE,
  isAutoresumeDisabled: () => AUTORESUME_DISABLED,
  limitResume02: LIMIT_RESUME_02,
  probeClaudeCliVersion: () => probeClaudeCliVersion(),
  getClaudeCliVersionCache: () => claudeCliVersionCache,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  isPackaged: () => app.isPackaged,
  repoRoot: REPO_ROOT,
  getDepartmentDirs: () => (typeof agentSettings !== 'undefined' ? agentSettings.readSettings().departmentDirs : []),
  readSettings: () => (typeof agentSettings !== 'undefined' ? agentSettings.readSettings() : {}),
  appI18n,
  integrationService: () => (typeof integrationService !== 'undefined' ? integrationService : null),
  codeIndexService: () => (typeof codeIndexService !== 'undefined' ? codeIndexService : null),
  getDelegationBridge: () => (typeof delegationBridgeService !== 'undefined' && delegationBridgeService ? delegationBridgeService.getBridge() : null),
  publicSupabaseEnv: () => (typeof backendEnvService !== 'undefined' ? backendEnvService.publicSupabaseEnv() : {}),
  memoryService: () => (typeof memoryService !== 'undefined' ? memoryService : null),
  delegationSupervisorService: () => (typeof delegationSupervisorService !== 'undefined' ? delegationSupervisorService : null),
  sendPaneEvent: (win, paneId, channel, payload) => (windowManager ? windowManager.sendPaneEvent(win, paneId, channel, payload) : null),
  jarvisWidgetAlive: () => (windowManager ? windowManager.jarvisWidgetAlive() : false),
  invalidateGitBranchCache: (dir) => invalidateGitBranchCache(dir),
  isQuitting: () => Boolean(app.isQuitting),
  isAutotest: () => AUTOTEST,
  hasMobileSubscribers: () => (typeof mobileService !== 'undefined' && mobileService && mobileService.mobileSubscribers ? mobileService.mobileSubscribers.size > 0 : false),
  emitMobileEvent: (evt) => (typeof mobileService !== 'undefined' && mobileService ? mobileService.emitMobileEvent(evt) : null),
  getJarvisConv: () => (typeof jarvisConv !== 'undefined' ? jarvisConv : null),
  appVersion: () => app.getVersion(),
  secretRedactor: () => (typeof secretRedactor !== 'undefined' ? secretRedactor : null),
  BrowserWindow,
  agentSettings,
  agentRunner,
});

const faultService = createFaultService({
  app,
  getAppWindow: () => appWindow,
  logLine,
  telemetryEnvNow: () => telemetryService.telemetryEnvNow(),
  telemetryEnabledNow: () => telemetryService.telemetryEnabledNow(),
  appRoot: path.resolve(__dirname, '..'),
});

// Fault and supervisor routines directly dispatched via faultService

// ── ADP-659/660/667/672/838 — DELEGASYON SUPERVISOR SERVİSİ (src/features/agents/delegationSupervisorService.js - Faz 3.6.22)
const delegationSupervisorService = createDelegationSupervisorService({
  ptys,
  crewpaneHome: () => crewpaneHome(),
  logLine: (line) => logLine(line),
  getAppWindow: () => appWindow,
  planDenial: (feat, count, opts) => planLimitService.planDenial(feat, count, opts),
  supervisorFor: (name) => faultService.supervisorFor(name),
  resolveWorkerNotifyPath: (dept) => ptyResumeService.resolveWorkerNotifyPath(dept),
  rendererSupabaseTarget: () => backendEnvService.rendererSupabaseTarget(),
  appDbTokenFor: (action) => backendEnvService.appDbTokenFor(action),
  telemetryBump: (key, by, props) => telemetryService.telemetryBump(key, by, props),
  resetCommandFor: (cmd) => paneControlService.resetCommandFor(cmd),
  maxTasksPerSession: 10,
  killPane: (id, entry, aid, why) => paneControlService.killPane(id, entry, aid, why),
  probeTranscriptVerdict: (paneId, needle, opts) => paneTranscriptService.probeTranscriptVerdict(paneId, needle, opts),
  probeTranscriptVerifiable: (paneId) => paneTranscriptService.probeTranscriptVerifiable(paneId),
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
// ── ADP-264 — KAYNAK BEKÇİSİ SERVİSİ (src/features/system/resourceGovernorService.js - Faz 3.6.58)
const { createResourceGovernorService } = require('./src/features/system');
const resourceGovernorService = createResourceGovernorService({
  agentSettings,
  getAppWindow: () => appWindow,
  logLine,
});

// ADP-050 — the live app window (IPC target for the delegation bridge) + the
// started bridge handle ({ port, token, stop, info }). One window in this app.
let appWindow = null;
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



// ── ADP-095/333/341/394/396/399/884 — BAŞLIKLI TARAYICI OTOMASYONU SERVİSİ (src/features/services/browserService.js - Faz 3.6.24)
const { createBrowserService } = require('./src/features/services');

const browserService = createBrowserService({
  getAppWindow: () => appWindow,
  logLine,
  saveBrowserShot: (b64, tag) => mediaService.saveBrowserShot(b64, tag),
  getAppWindowGuest: () => appWindowGuest,
  setAppWindowGuest: (g) => { appWindowGuest = g; },
  browserCdp,
  browserGateMod,
});

// ADP-475 — crash instrumentation & main stall monitor (src/features/system/crashWatchdogService.js - Faz 3.6.9)
const { createCrashWatchdogService } = require('./src/features/system');

const crashWatchdogService = createCrashWatchdogService({
  app,
  BrowserWindow,
  ptys,
  logLine,
  resourceGovernor: () => resourceGovernorService.resourceGovernor(),
  crashWatchdog,
});



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

// ─── ADP-660/BL-01 — Katman Limitleri & Nudge Yönetimi (src/features/auth/planLimitService.js - Faz 3.6.13)
const planLimitService = createPlanLimitService({
  getSeatGate: () => (typeof authService !== 'undefined' && authService ? authService.getSeatGate() : null),
  getAppWindow: () => appWindow,
  analyticsNow: () => telemetryService.analyticsNow(),
  logLine,
});

const authService = createAuthService({
  instancePaths,
  app,
  shell,
  logLine,
  getAppWindow: () => appWindow,
  pushPlanLimit: (denial) => planLimitService.pushPlanLimit(denial),
  integrityReportOnce: () => integrityService.integrityReportOnce(),
  ptys,
  persistScreenTails: () => paneQueryService.persistScreenTails(),
  livePaneRegistry,
  crewpaneHome: () => crewpaneHome(),
  killAllPtys: () => paneQueryService.killAllPtys(),
  noteQuit: (r) => noteQuit(r),
  armQuitBrake: (r) => armQuitBrake(r),
  agentSettings,
  getResourceGovernor: () => resourceGovernorService.resourceGovernor(),
  appI18n,
  testSeamDeps: {
    updateCheck,
    supervisorPushRenderer: (c, p) => delegationSupervisorService.supervisorPushRenderer(c, p),
    planWaveLimit: (r) => planLimitService.planWaveLimit(r),
    spawnPty: (win, opts) => ptySpawnService.spawnPty(win, opts),
    ptys,
    livePaneRegistry,
    crewpaneHome: () => crewpaneHome(),
    killPane: (id, e, aid, r) => paneControlService.killPane(id, e, aid, r),
    mobilePlanDenial: (opts) => mobileService.mobilePlanDenial(opts),
    designPlanDenial: ({ notify = true } = {}) => planLimitService.planDenial('designMode', 0, { notify }),
    BrowserWindow,
    getRestoreSkippedByPlan: () => paneRestoreService.getRestoreSkippedByPlan(),
    getSupervisorAdvanceBlocked: () => delegationSupervisorService.getSupervisorAdvanceBlocked(),
  },
});

// Auth routines directly dispatched via authService



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
  createWorkspaceServicesBundle,
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



// ── ADP-719/801/833/954 — AUTH URL & DEEP LINK SERVICE (src/features/auth/authUrlService.js - Faz 3.6.36)
const authUrlService = createAuthUrlService({
  app,
  appUrlPrefix: APP_URL_PREFIX,
  getSeatGate: () => (typeof authService !== 'undefined' && authService ? authService.getSeatGate() : null),
  isAutomatedSession: IS_AUTOMATED_SESSION,
  automatedSessionReason: AUTOMATED_SESSION_REASON,
  logLine: (line) => logLine(line),
});

let schemeVerdict = null;



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

const {
  gitBranchCache,
  GIT_BRANCH_TTL_MS,
  invalidateGitBranchCache,
} = require('./src/shared/utils');

// ── ADP-WORKSPACE-BUNDLE — ÇALIŞMA ALANI & DOSYA SERVİSLERİ PAKETİ (src/features/services/workspaceServicesBundle.js - Faz 3.6.63)
const {
  codeIndexService,
  workspaceRootService,
  workspaceFileService,
} = createWorkspaceServicesBundle({
  app,
  BrowserWindow,
  dialog,
  ptys,
  agentSettings,
  crewpaneHome: () => crewpaneHome(),
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  setAgentWorkspaceRoot: (val) => { agentWorkspaceRoot = val; },
  planLimitService: () => (typeof planLimitService !== 'undefined' ? planLimitService : null),
  invalidateGitBranchCache,
  appI18n,
  logLine,
  repoRoot: REPO_ROOT,
  forceFirstRun: FORCE_FIRST_RUN,
});

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

// ── ADP-IPC-WIRE — IPC BAĞLANTI & BAĞIMLILIK DERLEYİCİSİ (src/main/ipc/ipcMainWiring.js - Faz 3.6.59)
function _collectWindowWorkspaceDeps() {
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
    appWindow,
    appBaseUrl,
    windowManager,
    crashWatchdog,
    APP_URL_SCHEME,
    APP_URL_PREFIX,
    MODE,
    authService,
    rebuildService,
    planLimitService,
    workspaceFileService,
    workspaceRootService,
    agentWorkspaceRoot,
    faultService,
    mergeService,
    worktreeService,
    REPO_ROOT,
    gitBranchCache,
    GIT_BRANCH_TTL_MS,
    codeIndexService,
    invalidateGitBranchCache,
    mediaService,
    memoryService,
    secretRedactor,
  };
}

function _collectTerminalExecutionDeps() {
  return {
    paneQueryService,
    paneControlService,
    ptySpawnService,
    ptyIsolationService,
    ptyResumeService,
    paneRestoreService,
    telemetryService,
    paneBudgetService,
    paneTranscriptService,
    paneDispatchService,
    paneAskService,
    resourceGovernorService,
    agentRunner,
    engineDelegation,
    mobileTranscript,
    modelDetect,
  };
}

function _collectMobileVoiceAndSystemDeps() {
  return {
    updateService,
    announceService,
    changelogService,
    resetBootService,
    apiKeyService,
    mobileService,
    syncService,
    announcements,
    updateCheck,
    noteQuit,
    browserService,
    setAppWindowGuest: (g) => { appWindowGuest = g; },
    getAppWindowGuest: () => appWindowGuest,
    integrationService,
    mcpProcess,
    spawn,
    appI18n,
    handService,
    mobileDeviceStore,
    jarvisWidget,
    jarvisVoice,
    instancePaths,
    jarvisConv,
    delegationQueueStore,
    teamComposeCore,
    teamComposeService,
    delegationSupervisorService,
    LOG_PATH,
    credentialGate,
    vendorSurface,
    telemetryMod,
    telemetryChannelMod,
    accountScope,
    schemeOwnership,
    schemeVerdict,
    IS_AUTOMATED_SESSION,
    AUTOMATED_SESSION_REASON,
    secretBackendState,
    authUrlService,
    crewpaneIdConfig,
    planLimits,
    backendEnvService,
    installReset,
    resetGate,
    updateChannel,
    appLocaleService,
    engineCheck,
    paneCapabilityMatrix,
    engineOffering,
    engineAuth,
    demoSitePath,
    doctorService,
    firstRunDoctor,
  };
}

function wireIpc() {
  const mainIpcWiring = createMainIpcWiring({
    ..._collectWindowWorkspaceDeps(),
    ..._collectTerminalExecutionDeps(),
    ..._collectMobileVoiceAndSystemDeps(),
  });
  return mainIpcWiring.wireIpc();
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
  mappedProjectRootsForReports: () => ptyIsolationService.mappedProjectRootsForReports(agentWorkspaceRoot),
});



// ---------------------------------------------------------------------------
// ADP-139 (DOGFOOD Engel #2) — one-click "Rebuild & Relaunch" (src/features/system/rebuildService.js - Faz 3.6.42)
// ---------------------------------------------------------------------------
const rebuildService = createRebuildService({
  app,
  spawn,
  repoRoot: REPO_ROOT,
  logLine,
  relaunchApp: (reason) => authService.relaunchApp(reason),
});


// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------



// ── HAND-A2 — "EL KONTROLÜ" Servisi (src/features/hand/service.js - Faz 3.6.6) ──
const { createHandService } = require('./src/features/hand');

const handService = createHandService({
  BrowserWindow,
  screen,
  systemPreferences: require('electron').systemPreferences,
  globalShortcut,
  getAppWindow: () => appWindow,
  openHandDetectWindow: () => windowManager.openHandDetectWindow(),
  handDetectAlive: () => windowManager.handDetectAlive(),
  feedHandOverlay: (raw) => windowManager.feedHandOverlay(raw),
  handOverlayPrefs: () => windowManager.handOverlayPrefs(),
  handTuningConfig: (prefs) => windowManager.handTuningConfig(prefs),
  agentSettings,
  logLine,
});

// ── Pencere Yönetimi (Faz 3.3): BrowserWindow yönetimi src/main/windows altında ──
windowManager = createWindowManager({
  BrowserWindow,
  shell,
  screen,
  Notification,
  app,
  preloadPath: path.join(__dirname, 'dist', 'preload.js'),
  supabaseTarget,
  backendEnvService,
  appI18n,
  applyAppLocale: () => appLocaleService.applyAppLocale(),
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
  rebindOrphanPanes: (win) => paneQueryService.rebindOrphanPanes(win),
  restoreLivePanes: (win) => paneRestoreService.restoreLivePanes(win),
  startPtyResumeDaemonOnce: () => ptyResumeService.startPtyResumeDaemonOnce(),
  ptys,
  noteQuit,
  crashWatchdog,
  keepPanesAliveOnWindowClose: () => paneQueryService.keepPanesAliveOnWindowClose(),
  liveAgentPaneCount: () => paneQueryService.liveAgentPaneCount(),
  killPtysForWindow: (winId) => paneQueryService.killPtysForWindow(winId),
  quitFunnel,
  armQuitBrake,
  reportsWatcher,
  activeWorktreePaths: () => ptyIsolationService.activeWorktreePaths(),
  mappedProjectRootsForReports: () => ptyIsolationService.mappedProjectRootsForReports(agentWorkspaceRoot),
  browserGuests: browserService.browserGuests,
  ghostGuests: () => browserService.ghostGuests,
  guestOwners: browserService.guestOwners,
  agentGuests: browserService.agentGuests,
  getPendingAgentTabs: () => browserService.pendingAgentTabs,
  getAppWindowGuest: () => appWindowGuest,
  setAppWindowGuest: (g) => { appWindowGuest = g; },
  lastUnownedGuest: () => browserService.lastUnownedGuest(),
  getHandControl: () => handService.handControl,
  stopHandControl: (why) => handService.stopHandControl(why),
  broadcastHandControlStatus: () => handService.broadcastHandControlStatus(),
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
  emitMobileEvent: (event) => mobileService.emitMobileEvent(event),
});
const jarvisConv = jarvisConversationService.conversation;

mobileService = createMobileService({
  app,
  ptys,
  getAppWindow: () => appWindow,
  rendererSupabaseTarget: () => backendEnvService.rendererSupabaseTarget(),
  getMobileAppDbToken: () => backendEnvService.mobileAppDbToken(),
  planDenial: (f, c, o) => planLimitService.planDenial(f, c, o),
  delegationBridgeMod,
  secretRedactor,
  mobileTranscript,
  currentSessionId: (id) => paneTranscriptService.currentSessionId(id),
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
  standaloneDir: () => nextServerManager.standaloneDir(),
});

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
  getBoundAccount: () => authService.getBoundAccount(),
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  publicSupabaseEnv: () => backendEnvService.publicSupabaseEnv(),
  accountScope,
  getSeatGate: () => authService.getSeatGate(),
  appDbTokenFor: (action) => backendEnvService.appDbTokenFor(action),
  memoryIndexDerive,
  pushPlanLimit: (denial) => planLimitService.pushPlanLimit(denial),
  logLine,
  broadcastLocale: () => appLocaleService.broadcastLocale(),
  getAppWindow: () => appWindow,
  getPopoutWindows: () => (windowManager ? windowManager.popoutWindows : new Map()),
  prefsProjectorFactory,
  syncBoot,
  syncSurface,
});

/** Tercih/kök/hedef değişti → motoru yeniden çöz (kapanışta ANINDA söker). */
// ── SYNC-F1-7 — TERCİH IPC'Sİ (renderer ekseni: localStorage) ────────────────
//
// Renderer'ın `localStorage`ı main'den OKUNAMAZ; bu yüzden düzen/sekme tercihleri
// iki yönlü bir IPC ile taşınır. Sınır DAR: renderer yalnız KENDİ eksenindeki
// (beyaz listede `renderer` kaynaklı) anahtarları yazabilir — `publishRenderer`
// gerisini düşürür, yani bir XSS yüzeyi buradan `locale`ı ya da bir sırrı
registerPrefsIpc({
  ipcMain,
  prefsProjector: () => syncService.prefsProjector(),
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
  seatGate: {
    state: () => (authService && authService.getSeatGate() ? authService.getSeatGate().state() : null),
  },
  paneControlService,
  ptys,
  getAppWindow: () => appWindow,
  logLine,
});

// ── ADP-050 — DELEGASYON KÖPRÜSÜ SERVİSİ (src/features/agents/delegationBridgeService.js - Faz 3.6.39)
const delegationBridgeService = createDelegationBridgeService({
  delegationBridgeMod,
  crewpaneEnv,
  crewpanePaths,
  resolveWindow: () => appWindow,
  logLine,
  ipcMain,
  runBrowserAction: (val) => browserService.runBrowserAction(val),
  probeBrowserTarget: (val) => browserService.probeBrowserTarget(val),
  getBrowserGate: () => browserService.browserGate(),
  paneControlService,
  teamComposeService,
  delegationSupervisorService,
  telemetryService,
  mediaService,
  ptyResumeService,
  getAgentWorkspaceRoot: () => agentWorkspaceRoot,
  mobileService,
  notifyLog,
  appDbTokenFor: (source) => backendEnvService.appDbTokenFor(source),
  integrationsStatusFor: (req) => integrationService.integrationsStatusFor(req),
  seatDenial: (action) => authService.seatDenial(action),
  planWaveLimit: (requested) => planLimitService.planWaveLimit(requested),
  deliverDictationToFocusedSurface: (text) => deliverDictationToFocusedSurface(text),
});

// ---------------------------------------------------------------------------
// KILL-GUARD-01 (madde 5) — DIŞARIDAN KAPATILDIK: uçuştaki işi DAMGALA.
// ---------------------------------------------------------------------------
// App Boot & Lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(async () => {
  const gate = await startupGate.runStartupGate(process.argv);
  if (!gate.proceed) return;

  const appBootService = createAppBootService({
    engineCoerce,
    livePaneRegistry,
    paneRestoreService,
    getAppWindow: () => appWindow,
    logLine,
    crashWatchdogService,
    app,
    startupSweepService,
    workspaceFileService,
    crewpaneHome,
    repoRoot: REPO_ROOT,
    nextServerManager,
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
    authService,
    syncService,
    authUrlService,
    workspaceRootService,
    wireIpc,
    resourceGovernorService,
    windowManager,
    BrowserWindow,
    autotest: AUTOTEST,
    noteQuit,
    groqShim,
    providers,
    adapter,
    registerJarvisShortcut,
    handService,
    updateService,
    announceService,
    changelogService,
    memoryService,
    jarvisVoice,
    notifyScreenshotsMovedOnce,
    doctorService,
    telemetryMod,
    agentSettings,
    telemetryService,
    faultService,
    telemetryChannelMod,
    tamperSignals,
    faultInject: FAULT_INJECT,
    externalUrl: process.env.CREWPANE_EXTERNAL_URL,
    mode: MODE,
    delegationBridgeService,
    mobileService,
  });

  await appBootService.boot();
});

// ── SEC-02/HATA-14/ADP-905 — YAŞAM DÖNGÜSÜ & TEMİZ ÇIKIŞ YÖNETİCİSİ (src/main/lifecycle - Faz 3.6.19)
const lifecycleManager = createLifecycleManager({
  app,
  process,
  globalShortcut,
  quitFunnel,
  crashJournal,
  instancePaths,
  authService,
  isAutotest: AUTOTEST,
  crewpaneHome: () => crewpaneHome(),
  armQuitBrake: (label) => armQuitBrake(label),
  crashWatchdogService,
  paneQueryService,
  nextServerManager,
  noteQuit: (reason, signal) => noteQuit(reason, signal),
  getLivePaneCount: () => ptys.size,
  getQuitReason: () => quitReason,
  getQuitSignal: () => quitSignal,
  appStartedAt: APP_STARTED_AT,
  logLine,
  livePaneRegistry,
  ptyResumeService,
  adapter,
  jarvisVoice,
  delegationBridgeService,
  delegationSupervisorService,
});
lifecycleManager.register();

