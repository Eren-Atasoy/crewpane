'use strict';

/**
 * Delegation Queue & Supervisor IPC Handlers (Faz 3.5 — Sıra 8)
 * Channels:
 *   - dlgqueue:save
 *   - dlgqueue:load
 *   - queueboard:get
 *   - dlgsup:record
 *   - dlgsup:settle
 *   - dlgsup:ack
 *   - dlgsup:debug
 *   - dlgsup:advance:result (on)
 */
function registerDelegationIpc({
  ipcMain,
  delegationQueueStore,
  delegationSupervisorStore,
  resumeQueueStore,
  queueBoard,
  evidencePathMod,
  supervisorFor = () => ({ run: (_name, fn) => fn() }),
  ensureDelegationSupervisor = () => {},
  scheduleSupervisorSweep = () => {},
  supervisorPending,
  supervisorFingerprint = () => null,
  ptys,
  crewpaneHome = () => '',
  getWorkspaceRoot = () => null,
  agentSettings,
  REPO_ROOT,
  activeWorktreePaths = () => [],
  logLine = () => {},
}) {
  // QUEUE-PERSIST — meşgul-kuyruğu + paused-delegasyon kalıcılığı (sprintStore
  // deseninin tek-dosya hali; path'i HEP main kurar, renderer yalnız durum objesi geçirir).
  ipcMain.handle('dlgqueue:save', (_event, state) => {
    try {
      return { ok: true, file: delegationQueueStore.saveQueueState(state) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('dlgqueue:load', () =>
    supervisorFor('queue-store').run(
      'load',
      () => ({ ok: true, state: delegationQueueStore.loadQueueState() }),
      { ok: false, reason: 'degraded' },
    ));

  // ── SUP-UI-01 — KUYRUK PANELİNİN VERİSİ (salt-okur) ──────────────────────
  // Eren'in şikâyeti: "bi iş başlıyo komut veriyo, ne nerden geldi niye geldi
  // anlaşılmıyor". Kuyruğun üç defteri diskte ZATEN duruyordu, hiçbir yüzeyde
  // görünmüyordu. Bu handler onları okur ve saf çekirdeğe (queueBoard.cjs) verir.
  //
  // Neden MAIN okuyor: (a) renderer fs'e inemez, (b) uçuş defteri (supervisor) ve
  // limit kuyruğu zaten main'in state'i, (c) TIKANMA ancak pane'in `lastDataAt`
  // damgasıyla görülür — o damga yalnız burada var. Panel EYLEMLERİ renderer'da
  // kalır (kuyruğun canlı sahibi delegationRunner'dır); bu kanal salt-okurdur.
  ipcMain.handle('queueboard:get', () =>
    supervisorFor('queue-board').run(
      'get',
      () => {
        const panes = [];
        for (const [paneId, entry] of ptys) {
          panes.push({
            paneId,
            agentId: entry.agentId || null,
            command: entry.command || null,
            // Tıkanma sondasının TEK sinyali: bu pane en son ne zaman BAYT üretti.
            lastDataAt: typeof entry.lastDataAt === 'number' ? entry.lastDataAt : 0,
            disallowSubagent: entry.disallowSubagent === true,
          });
        }
        // e2e dikişi: "pane boşta" eşiği üründe 2 dakikadır; test o kadar bekleyemez.
        // (Aynı desen supervisor'ın CREWPANE_SUPERVISOR_* dikişlerinde kullanılıyor.)
        const idleEnv = Number(process.env.CREWPANE_QUEUEBOARD_IDLE_MS);
        const sup = ensureDelegationSupervisor();
        const outcomeLedger = sup && typeof sup.getOutcomeLedger === 'function' ? sup.getOutcomeLedger() : null;
        const board = queueBoard.buildQueueBoard({
          now: Date.now(),
          ...(Number.isFinite(idleEnv) && idleEnv > 0 ? { idleMs: idleEnv } : {}),
          supervisor: delegationSupervisorStore.loadState(crewpaneHome()),
          queueState: delegationQueueStore.loadQueueState(crewpaneHome()),
          resumeQueue: resumeQueueStore.loadQueue(crewpaneHome()),
          outcomeLedger,
          panes,
        });
        return {
          ok: true,
          board,
          // Defterlerin YOLLARI panelde görünür: "hangi dosyaya bakıyorum?" sorusu
          // ekrandan cevaplanabilsin (yeni defter icat edilmediğinin kanıtı da bu).
          sources: {
            queue: delegationQueueStore.queuePath(crewpaneHome()),
            supervisor: delegationSupervisorStore.supervisorPath(crewpaneHome()),
            resume: resumeQueueStore.queuePath(crewpaneHome()),
          },
        };
      },
      { ok: false, reason: 'degraded' },
    ));

  // ── ADP-659 — DELEGASYON SUPERVISOR köprüsü (renderer → main defteri) ──────
  // Renderer her dispatch'i BURAYA kaydeder. Bundan sonra takip renderer'a bağlı
  // DEĞİLDİR: renderer reload olsa/ölse de main defteri diskte durur ve gözcü
  // tamamlanmayı kendi ölçer. Kanıt yolu MAIN'de mutlaklaştırılır (pane cwd'si
  // main'in defterinde — ADP-502) ve baseline de MAIN'in hash'iyle alınır, böylece
  // karşılaştırma hep aynı algoritmayla yapılır.
  ipcMain.handle('dlgsup:record', (_event, input) =>
    supervisorFor('delegation-supervisor').run(
      'record',
      () => {
        const sup = ensureDelegationSupervisor();
        const input0 = input || {};
        const entry = input0.paneId ? ptys.get(input0.paneId) : null;
        // ADP-735 — kanıt yolu TEK köke çözülüyordu (`cwd || pane.cwd || workspaceRoot`).
        // Kurulu makinede bu köklerin hepsi workspace PARENT'ı ("CrewPane Apps") ama
        // worker raporunu ALT-PROJEYE yazar → `<ws>/docs/agent-results/…` diye var
        // OLMAYAN bir yol kaydediliyor, kanıt kapısı asla ateşlenemiyordu (2026-07-29:
        // 9 kaydın 9'u "beklenen çıktı yok" ile BAŞARISIZ). Artık aday listesi üretilir
        // ve her adayın baseline'ı ayrı alınır — supervisor hepsini yoklar.
        // B-01 (F-7) — izole koşan görev raporunu KENDİ worktree'sine yazar. Pane'in
        // worktree'si biliniyorsa (kayıttan) o ağaç aday tabanı olur; bilinmiyorsa
        // aktif ağaçların hepsi yoklanır. Bu satır olmadan izolasyon açıldığı anda
        // HER görev "beklenen çıktı yok" ile SAHTE-FAIL alırdı (R-3).
        const paneWt = entry && typeof entry.worktreePath === 'string' ? entry.worktreePath : null;
        const agentWorkspaceRoot = getWorkspaceRoot();
        const rec = evidencePathMod.shapeEvidenceRecord(input0, {
          cwd: entry && entry.cwd,
          workspaceRoot: agentWorkspaceRoot,
          department: input0.department || (entry && entry.department),
          mapping: agentSettings.readSettings().departmentDirs,
          repoRoot: REPO_ROOT,
          worktreePaths: paneWt ? [paneWt] : activeWorktreePaths(),
          fingerprint: supervisorFingerprint,
        });
        if (rec.evidencePath && rec.evidencePath !== input0.evidencePath) {
          logLine(
            `supervisor: kanıt yolu çözüldü ${input0.evidencePath} → ${rec.evidencePath}` +
              (rec.evidenceAlt && rec.evidenceAlt.length ? ` (+${rec.evidenceAlt.length} alternatif kök)` : ''),
          );
        }
        return { ok: !!sup.record(rec) };
      },
      { ok: false },
    ));

  // Motor NORMAL yolda settle etti → defteri hizala (supervisor çift-iş yapmaz).
  ipcMain.handle('dlgsup:settle', (_event, p) =>
    supervisorFor('delegation-supervisor').run(
      'settle',
      () => {
        const sup = ensureDelegationSupervisor();
        const ok = sup.settle((p && p.delegationId) || '', (p && p.subtaskId) || '', p || {});
        // ADP-667 — lider-pane uyandırmasının sahibi supervisor: toplama penceresi
        // dolar dolmaz süpür (normal 15sn tick'i bekleyip bildirimi geciktirme).
        if (ok) {
          const cfg = sup.config ? sup.config() : {};
          scheduleSupervisorSweep((cfg.wakeCoalesceMs || 10_000) + 800);
        }
        return { ok };
      },
      { ok: false },
    ));

  // Lider gerçekten baktı (MCP `crewpane_delegation_status`) → uyandırma durur.
  ipcMain.handle('dlgsup:ack', (_event, leaderId) =>
    supervisorFor('delegation-supervisor').run(
      'ack',
      () => ({ ok: true, cleared: ensureDelegationSupervisor().ack(String(leaderId || '')) }),
      { ok: false },
    ));

  // e2e/teşhis: defteri oku + tick'i elle sür (zamanlayıcıyı beklemeden).
  ipcMain.handle('dlgsup:debug', async (_event, action) => {
    const sup = ensureDelegationSupervisor();
    if (action === 'sweep') await sup.sweep();
    if (action === 'repair') sup.repairAfterRestart();
    return { ok: true, state: sup.snapshot(), config: sup.config() };
  });

  // Renderer'ın kuyruk-ilerletme cevabı (supervisorAskRenderer'ın diğer ucu).
  ipcMain.on('dlgsup:advance:result', (_event, msg) => {
    const pending = msg && supervisorPending && supervisorPending.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    supervisorPending.delete(msg.requestId);
    pending.resolve(msg.ok !== false);
  });
}

module.exports = { registerDelegationIpc };
