'use strict';

const fs = require('fs');
const path = require('path');
const livePaneRegistry = require('../../agents/livePaneRegistry.cjs');
const agentEngineMirror = require('../../agents/agentEngineMirror.cjs');
const paneSessionsJournal = require('../../terminal/paneSessionsJournal.cjs');
const agentRunner = require('../../agents/agentRunner.js');

const RECOVERABLE_FILE = 'live-panes.recoverable.json';
const DEFAULT_BARE_RESTORE_ASK = 12;
const DEFAULT_LEDGER_BLOAT_WARN = 40;

function resolveBareThreshold(configuredThreshold) {
  if (Number.isFinite(configuredThreshold)) return configuredThreshold;
  const envVal = Number(process.env.CREWPANE_BARE_RESTORE_ASK);
  if (Number.isFinite(envVal)) return envVal;
  return DEFAULT_BARE_RESTORE_ASK;
}

function formatId(val) {
  return val ? String(val) : '-';
}

function extractPaneId(res) {
  if (!res) return null;
  return res.paneId || null;
}

function buildRespawnOpts(entry, ctx, paneEngineResolver) {
  const opts = {
    command: entry.engine,
    cwd: entry.cwd || undefined,
    agentId: entry.agentId || null,
    restoreKey: entry.restoreKey || undefined,
    department: entry.department || null,
    label: entry.label || null,
    role: entry.role || undefined,
    plain: entry.plain === true,
    browserCapable: entry.browserCapable === true,
    disallowSubagent: entry.disallowSubagent === true,
    systemPrompt: entry.systemPrompt || undefined,
    sessionId: entry.sessionId || undefined,
    model: entry.model || undefined,
    provider: entry.provider || undefined,
    resume: true,
    screenTail: Array.isArray(entry.screenTail) ? entry.screenTail : undefined,
  };
  return paneEngineResolver.applyTo(opts, entry, ctx.where || 'restore');
}

function checkClaudeSessionResumed(opts) {
  if (opts.resume !== true) return false;
  if (opts.command !== 'claude') return false;
  return agentRunner.isUuid(opts.sessionId);
}

function sendRecoverableEvent(win, list, meta) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send('panes:recoverable', {
      count: list.length,
      reason: meta.reason || null,
      source: meta.source || null,
      agents: list.map((e) => ({
        agentId: e.agentId || null,
        department: e.department || null,
        engine: e.engine || null,
        sessionId: e.sessionId || null,
      })),
    });
  } catch { /* pencere kapandıysa sessizce devam */ }
}

function compactRegistrySafely(crewpaneHome, logLine, reportLedgerBloat) {
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
}

function resolveRecoverableSource(crewpaneHome, logLine) {
  let snapshot = [];
  try {
    snapshot = livePaneRegistry.restoreSnapshot(crewpaneHome());
  } catch (e) {
    logLine(`restore: snapshot read failed: ${e.message}`);
    return { snapshot: null, error: e };
  }
  let found = null;
  try {
    found = livePaneRegistry.discoverRecoverable(crewpaneHome());
  } catch {
    found = null;
  }
  return { snapshot, found };
}

function mergeSnapshotWithDiscovered(snapshot, found, activeRootNow, logLine) {
  let entries = snapshot;
  let fromFallback = false;
  let consumedForeign = null;

  if (found && !found.stale && !(entries.length && found.source.root === activeRootNow)) {
    const known = new Set(entries.map((e) => livePaneRegistry.identityKey(e)));
    const extra = found.entries.filter((e) => !known.has(livePaneRegistry.identityKey(e)));
    if (!entries.length) {
      entries = found.entries;
      fromFallback = true;
    } else if (extra.length) {
      entries = entries.concat(extra);
    }
    if (fromFallback || extra.length) {
      if (fromFallback && found.source.kind === 'snapshot') {
        logLine(`restore: fell back to quit snapshot (${entries.length} pane(s))`);
      }
      logLine(
        `restore: kaynak=${found.source.kind} kök=${found.source.root} ` +
          `(${found.source.count} pane, ${new Date(found.source.at).toISOString()}) → ${fromFallback ? 'tamamı' : `+${extra.length} ek`}`,
      );
      if (found.source.root !== activeRootNow) consumedForeign = found.source;
    }
  }
  return { entries, fromFallback, consumedForeign };
}

function handleEmptySnapshot(win, found, crewpaneHome, logLine, offerRecoverablePanes) {
  if (found && found.stale) {
    offerRecoverablePanes(win, found.entries, {
      reason: 'stale-snapshot',
      source: found.source,
    });
    return;
  }
  logLine('restore: no live agent panes to resume');
  try {
    const known = paneSessionsJournal.recoverSessions(crewpaneHome());
    if (known.length) {
      logLine(
        `restore: journal ${known.length} ajan oturumu biliyor (kurtarma için): ` +
          known.map((k) => `${k.agentId}=${k.sessionId}`).join(', '),
      );
    }
  } catch { /* teşhis best-effort */ }
}

function filterBarePanes(entries, bareThreshold, win, offerRecoverablePanes, logLine) {
  if (bareThreshold <= 0) return { entries, askHeld: [] };
  const bare = entries.filter((e) => !e.agentId);
  if (bare.length <= bareThreshold) return { entries, askHeld: [] };

  const askHeld = bare;
  const filtered = entries.filter((e) => e.agentId);
  offerRecoverablePanes(win, askHeld, { reason: 'bare-pane-threshold' });
  logLine(
    `restore: ${askHeld.length} çıplak motor pane'i OTOMATİK AÇILMADI (eşik=${bareThreshold}) — ` +
      'kullanıcıya soruldu; ajanlı pane\'ler normal geri yüklenir',
  );
  return { entries: filtered, askHeld };
}

function consumeAndRetire(fromFallback, consumedForeign, crewpaneHome, logLine) {
  if (!fromFallback) {
    try { livePaneRegistry.writeQuitSnapshot(crewpaneHome()); } catch { /* best-effort */ }
  }
  try { livePaneRegistry.clearAll(crewpaneHome()); } catch { /* best-effort */ }
  if (consumedForeign) {
    const retired = livePaneRegistry.retireConsumedSource(consumedForeign.file);
    logLine(
      retired
        ? `restore: yabancı kök tüketildi → emekliye ayrıldı ${consumedForeign.file} → ${retired}`
        : `restore: yabancı kök tüketildi ama emekliye AYRILAMADI (${consumedForeign.file}) — bir sonraki açılışta yeniden keşfedilebilir`,
    );
  }
}

function persistHeldEntries(askHeld, heldByPlan, crewpaneHome, logLine) {
  if (askHeld.length > 0) {
    let held = 0;
    for (const entry of askHeld) {
      try {
        livePaneRegistry.recordPane(`ask-hold:${livePaneRegistry.identityKey(entry)}`, entry, crewpaneHome());
        held += 1;
      } catch (e) {
        logLine(`restore: eşik — kayıt geri yazılamadı pane=${formatId(entry.label)}: ${e.message}`);
      }
    }
    logLine(`restore: eşik — ${askHeld.length} çıplak pane bekletildi (${held} kaydı defterde duruyor)`);
  }

  if (heldByPlan.length > 0) {
    let held = 0;
    for (const entry of heldByPlan) {
      const key = `plan-hold:${entry.agentId || entry.sessionId || String(held)}`;
      try {
        livePaneRegistry.recordPane(key, entry, crewpaneHome());
        held += 1;
      } catch (e) {
        logLine(`restore: plan tavanı — kayıt geri yazılamadı agent=${formatId(entry.agentId)}: ${e.message}`);
      }
    }
    logLine(
      `restore: plan tavanı — ${heldByPlan.length} pane açılmadı (${held} kaydı defterde duruyor; ` +
        'bir ajanı kapatınca elle açılabilir)',
    );
  }
}

function notifyRestoredPanes(win, restoredCount, agents, alreadyLive) {
  if (!restoredCount && !alreadyLive) return;
  if (!win || win.isDestroyed()) return;
  win.webContents.send('panes:restored', {
    count: restoredCount,
    agents,
    survived: alreadyLive,
  });
}

function shouldSkipRestore(panesRestored, isRestoreDisabled, isAppProbe, getMode) {
  if (panesRestored) return true;
  if (isRestoreDisabled()) return true;
  if (isAppProbe()) return true;
  return getMode() === 'spike';
}

function retireOfferSourceIfForeign(offer, restored, crewpaneHome, logLine) {
  const offerSource = offer && offer.source;
  if (!restored || !offerSource || !offerSource.file) return;
  const activeRoot = livePaneRegistry.crewpaneDir(crewpaneHome());
  if (offerSource.root !== activeRoot) {
    const retired = livePaneRegistry.retireConsumedSource(offerSource.file);
    logLine(`restore(offer): kaynak emekliye ayrıldı ${offerSource.file}${retired ? ` → ${retired}` : ' (BAŞARISIZ)'}`);
  }
}

class PaneRestoreService {
  constructor(deps) {
    const d = deps || {};
    this.crewpaneHome = d.crewpaneHome || (() => process.env.HOME || '');
    this.logLine = d.logLine || (() => {});
    this.reportModuleFault = d.reportModuleFault || (() => {});
    this.planDenial = d.planDenial || (() => {});
    this.spawnPty = d.spawnPty || (() => null);
    this.getAppWindow = d.getAppWindow || (() => null);
    this.ptys = d.ptys || new Map();
    this.isRestoreDisabled = d.isRestoreDisabled || (() => false);
    this.isAppProbe = d.isAppProbe || (() => false);
    this.getMode = d.getMode || (() => '');
    this.bareThreshold = resolveBareThreshold(d.bareRestoreAskThreshold);
    this.ledgerBloatWarn = d.ledgerBloatWarn || DEFAULT_LEDGER_BLOAT_WARN;

    this.pendingRecoverable = null;
    this.restoreSkippedByPlan = 0;
    this.panesRestored = false;

    this.paneEngineResolver = agentEngineMirror.createResolver({
      homedir: () => this.crewpaneHome(),
      log: (line) => this.logLine(line),
      disabled: () => process.env.CREWPANE_ENGINE_DRIFT_OFF === '1',
    });
  }

  respawnOptsFromEntry(entry, ctx = {}) {
    return buildRespawnOpts(entry, ctx, this.paneEngineResolver);
  }

  reportLedgerBloat(before, after) {
    if (!Number.isFinite(before) || before <= this.ledgerBloatWarn) return;
    this.reportModuleFault({
      module: 'pane',
      label: 'live-panes',
      level: 'warning',
      message:
        `live-panes defteri ${before} kayıt (eşik ${this.ledgerBloatWarn}) — ` +
        `tekilleştirmeden sonra ${after}`,
      location: 'restoreLivePanes',
      stopped: false,
      fatal: false,
    });
  }

  offerRecoverablePanes(win, entries, meta = {}) {
    const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (!list.length) return null;
    this.pendingRecoverable = { at: Date.now(), ...meta, entries: list };
    const file = path.join(livePaneRegistry.crewpaneDir(this.crewpaneHome()), RECOVERABLE_FILE);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.pendingRecoverable, null, 2));
    } catch { /* teklif diske yazılamasa da log + IPC ayakta */ }
    this.logLine(
      `restore: ${list.length} pane KURTARILABİLİR (otomatik açılmadı, sebep=${meta.reason || '-'}): ` +
        list.map((e) => `${formatId(e.agentId)}=${formatId(e.sessionId)}`).join(', ') +
        ` · teklif=${file}`,
    );
    sendRecoverableEvent(win, list, meta);
    return this.pendingRecoverable;
  }

  loadOfferForAccept() {
    if (this.pendingRecoverable) return this.pendingRecoverable;
    try {
      return JSON.parse(
        fs.readFileSync(path.join(livePaneRegistry.crewpaneDir(this.crewpaneHome()), RECOVERABLE_FILE), 'utf8'),
      );
    } catch {
      return null;
    }
  }

  executeOfferEntry(entry, targetWin, planSkipped) {
    try {
      const opts = { ...this.respawnOptsFromEntry(entry, { where: 'teklif' }), spawnIntent: 'restore' };
      const res = this.spawnPty(targetWin, opts);
      if (res && res.planLimited) {
        planSkipped.push(entry);
        this.restoreSkippedByPlan += 1;
        return { restored: false };
      }
      if (res && res.reused) return { restored: false };
      return { restored: true };
    } catch (e) {
      this.logLine(`restore(offer): respawn failed agent=${formatId(entry.agentId)}: ${e.message}`);
      return { restored: false };
    }
  }

  acceptRecoverablePanes(win) {
    const offer = this.loadOfferForAccept();
    const entries = offer && Array.isArray(offer.entries) ? offer.entries : [];
    if (!entries.length) return { ok: false, restored: 0, error: 'kurtarılabilir kayıt yok' };

    let restored = 0;
    const planSkipped = [];
    const targetWin = win || this.getAppWindow();

    for (const entry of entries) {
      const exec = this.executeOfferEntry(entry, targetWin, planSkipped);
      if (exec.restored) restored += 1;
    }

    retireOfferSourceIfForeign(offer, restored, this.crewpaneHome, this.logLine);

    if (planSkipped.length) {
      this.pendingRecoverable = { ...(offer || {}), entries: planSkipped };
      this.logLine(
        `restore(offer): plan tavanı — ${planSkipped.length} pane açılmadı (teklif duruyor): ` +
          planSkipped.map((e) => `${formatId(e.agentId)}=${formatId(e.sessionId)}`).join(', '),
      );
      this.planDenial('agents', this.ptys.size, { variant: 'restore', context: { pending: planSkipped.length } });
    } else {
      this.pendingRecoverable = null;
    }

    this.logLine(`restore(offer): ${restored}/${entries.length} pane açıldı`);
    return { ok: true, restored, total: entries.length, planSkipped: planSkipped.length };
  }

  handleReusedRestore(entry, res) {
    try {
      livePaneRegistry.recordPane(res.paneId, entry, this.crewpaneHome());
    } catch (e) {
      this.logLine(`restore: canlı pane defteri geri yazılamadı paneId=${res.paneId}: ${e.message}`);
    }
    this.logLine(`restore: skip already-live agent=${formatId(entry.agentId)} (pane ${res.paneId} reuse)`);
  }

  respawnSingleEntry(win, entry) {
    if (!entry.engine) {
      this.logLine(
        `restore: MOTOR BİLİNMİYOR → atlandı agent=${formatId(entry.agentId)} pane=${formatId(entry.paneId)} ` +
          '(engine=null; claude varsayılmadı — kayıt defterde duruyor)',
      );
      return { skipped: true };
    }
    const opts = { ...this.respawnOptsFromEntry(entry, { where: 'yeniden-başlatma' }), spawnIntent: 'restore' };
    try {
      const res = this.spawnPty(win, opts);
      if (res && res.planLimited) {
        this.restoreSkippedByPlan += 1;
        return { planLimited: true };
      }
      if (res && res.reused) {
        this.handleReusedRestore(entry, res);
        return { reused: true };
      }
      const spawnedEngine = opts.command;
      const resumed = checkClaudeSessionResumed(opts);
      const pidStr = formatId(extractPaneId(res));
      const modeStr = resumed ? 'resume' : 'fresh';
      this.logLine(
        `restore: respawned agent=${formatId(entry.agentId)} dept=${formatId(entry.department)} ` +
          `engine=${spawnedEngine} mode=${modeStr} paneId=${pidStr}`,
      );
      return {
        restored: {
          agentId: entry.agentId,
          department: entry.department,
          paneId: extractPaneId(res),
          engine: spawnedEngine,
          resumed,
        },
      };
    } catch (e) {
      this.logLine(`restore: respawn failed agent=${formatId(entry.agentId)}: ${e.message}`);
      return { failed: true };
    }
  }

  processRestoreEntries(win, entries) {
    const restored = [];
    let alreadyLive = 0;
    const heldByPlan = [];

    for (const entry of entries) {
      const outcome = this.respawnSingleEntry(win, entry);
      if (outcome.planLimited) {
        heldByPlan.push(entry);
      } else if (outcome.reused) {
        alreadyLive += 1;
      } else if (outcome.restored) {
        restored.push(outcome.restored);
      }
    }
    return { restored, alreadyLive, heldByPlan };
  }

  restoreLivePanes(win) {
    if (shouldSkipRestore(this.panesRestored, this.isRestoreDisabled, this.isAppProbe, this.getMode)) return;
    this.panesRestored = true;

    compactRegistrySafely(this.crewpaneHome, this.logLine, (b, a) => this.reportLedgerBloat(b, a));

    const { snapshot, found, error } = resolveRecoverableSource(this.crewpaneHome, this.logLine);
    if (error || !snapshot) return;

    const activeRootNow = livePaneRegistry.crewpaneDir(this.crewpaneHome());
    const merged = mergeSnapshotWithDiscovered(snapshot, found, activeRootNow, this.logLine);
    if (!merged.entries.length) {
      handleEmptySnapshot(win, found, this.crewpaneHome, this.logLine, (w, ent, m) => this.offerRecoverablePanes(w, ent, m));
      return;
    }

    const filteredBare = filterBarePanes(
      merged.entries,
      this.bareThreshold,
      win,
      (w, ent, m) => this.offerRecoverablePanes(w, ent, m),
      this.logLine,
    );
    consumeAndRetire(merged.fromFallback, merged.consumedForeign, this.crewpaneHome, this.logLine);

    const { restored, alreadyLive, heldByPlan } = this.processRestoreEntries(win, filteredBare.entries);

    notifyRestoredPanes(win, restored.length, restored, alreadyLive);
    this.logLine(`restore: ${restored.length}/${merged.entries.length} agent pane(s) resumed (already-live=${alreadyLive})`);
    persistHeldEntries(filteredBare.askHeld, heldByPlan, this.crewpaneHome, this.logLine);
  }

  getPendingRecoverable() {
    return this.pendingRecoverable;
  }

  getRestoreSkippedByPlan() {
    return this.restoreSkippedByPlan;
  }

  isPanesRestored() {
    return this.panesRestored;
  }

  setPanesRestored(val) {
    this.panesRestored = Boolean(val);
  }
}

function createPaneRestoreService(deps) {
  return new PaneRestoreService(deps);
}

module.exports = {
  createPaneRestoreService,
  PaneRestoreService,
  RECOVERABLE_FILE,
  DEFAULT_BARE_RESTORE_ASK,
  DEFAULT_LEDGER_BLOAT_WARN,
};
