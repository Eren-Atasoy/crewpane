'use strict';

/**
 * Startup Sweep Service (ADP-307, ADP-900, TTS-ORPHAN-01, MCP-COST-01, ADP-727).
 * Encapsulates background sweeps, e2e residue checks, orphan cleanups and delayed memory indexing.
 */
function createStartupSweepService({
  getPublicSupabaseEnv = () => ({}),
  agentSettings = {},
  getAgentWorkspaceRoot = () => null,
  getMemoryIndexer = () => null,
  jarvisVoice = null,
  mcpProcess = null,
  helperReaper = null,
  logLine = () => {},
  autoIndexDelayMs = 15000,
} = {}) {
  /**
   * ADP-307 — açılışta e2e-artık taraması. SALT-OKUNUR: canlı ofis DB'sinden ASLA satır
   * silmez. Bulursa log'a yazar; temizliği insan onaylar. Ağ hatası sessizce yutulur.
   */
  function scanE2EResidueAtStartup() {
    const env = typeof getPublicSupabaseEnv === 'function' ? getPublicSupabaseEnv() : getPublicSupabaseEnv;
    const url = env && env.NEXT_PUBLIC_CREWPANE_SUPABASE_URL;
    const key = env && env.NEXT_PUBLIC_CREWPANE_SUPABASE_ANON_KEY;
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
          `⚠️ [adp-307] ${rows.length} e2e test artığı bulundu (${where}) — bir spec bu DB'ye yazmış. `
          + 'Otomatik SİLİNMEDİ. İncele: node e2e/prodResidueGuard.cjs'
        );
      })
      .catch(() => { /* DB kapalı / eski şema — açılışı bloklama */ });
  }

  /**
   * ADP-900 — hafıza arama indeksini arka planda, düşük öncelikle, gecikmeli kur.
   */
  let autoIndexScheduled = false;
  function scheduleAutoMemoryIndex() {
    if (autoIndexScheduled) return;
    autoIndexScheduled = true;
    const delay = Number.isFinite(autoIndexDelayMs) ? autoIndexDelayMs : 15000;
    const t = setTimeout(() => {
      try {
        const settings = typeof agentSettings.readSettings === 'function' ? agentSettings.readSettings() : {};
        if (settings.memorySearch?.autoIndex === false) {
          logLine('memoryIndex(auto): kullanıcı kapatmış — atlandı');
          return;
        }
        const workspaceRoot = typeof getAgentWorkspaceRoot === 'function'
          ? getAgentWorkspaceRoot()
          : getAgentWorkspaceRoot;
        if (!workspaceRoot) {
          logLine('memoryIndex(auto): çalışma alanı yok — atlandı');
          return;
        }
        const svc = typeof getMemoryIndexer === 'function' ? getMemoryIndexer() : getMemoryIndexer;
        if (!svc || (typeof svc.status === 'function' && svc.status().running)) return;
        const res = svc.start({ workspaceRoot, auto: true });
        logLine(`memoryIndex(auto): ${res.ok ? `başladı → ${res.dbFile}` : `başlatılamadı (${res.reason})`}`);
      } catch (err) {
        logLine(`memoryIndex(auto): başlatılamadı: ${err.message}`);
      }
    }, delay);
    t.unref?.();
  }

  /**
   * TTS-ORPHAN-01 · katman D — AÇILIŞTA YETİM `say` SÜPÜRGESİ.
   */
  function sweepOrphanSayProcesses() {
    try {
      if (!jarvisVoice || typeof jarvisVoice.sweepOrphanSayProcesses !== 'function') return;
      const swept = jarvisVoice.sweepOrphanSayProcesses();
      if (swept.killed && swept.killed.length) {
        logLine(`tts: ${swept.killed.length} yetim \`say\` süreci temizlendi (${swept.killed.join(', ')})`);
      } else if (swept.skipped) {
        logLine(`tts: yetim \`say\` süpürgesi atlandı (${swept.reason} — yerel say/afplay yalnız macOS'ta)`);
      } else if (swept.reason) {
        logLine(`tts: yetim süpürgesi koşamadı — ${swept.reason}`);
      }
    } catch (e) {
      logLine(`tts: yetim süpürgesi hata verdi — ${e && e.message}`);
    }
  }

  /**
   * MCP-COST-01 — AÇILIŞ SÜPÜRMESİ: sahipsiz kalan MCP çocuklarını biçer.
   */
  function scheduleMcpOrphanReap() {
    if (!mcpProcess || typeof mcpProcess.reapOrphanMcp !== 'function') return;
    const t = setTimeout(() => {
      mcpProcess.reapOrphanMcp().then((res) => {
        if (res && res.reaped && res.reaped.length) {
          logLine(`mcp-sweep(boot) reaped=${res.reaped.length}/${res.scanned} `
            + `pids=${res.reaped.map((r) => r.pid).join(',')}`);
        }
      }).catch((e) => logLine(`mcp-sweep(boot) failed: ${(e && e.message) || e}`));
    }, 5000);
    t.unref?.();
  }

  /**
   * ADP-727 (katman A) — AÇILIŞTA YETİM TOPLA: sahipsiz kalan yardımcı süreçleri süpürür.
   */
  function sweepOrphanHelpers({ crewpaneHome, repoRoot, standaloneDir, isPackaged, resourcesPath }) {
    if (!helperReaper) return;
    try {
      const home = typeof crewpaneHome === 'function' ? crewpaneHome() : crewpaneHome;
      const reap = helperReaper.reapStaleHelpers(home, { log: logLine });
      if (reap.reaped && reap.reaped.length) {
        logLine(`startup reap: ${reap.reaped.length} orphan helper(s) killed (${reap.reaped.map((r) => `${r.kind}:${r.pid}`).join(', ')})`);
      } else if (reap.checked) {
        logLine(`startup reap: ${reap.checked} ledger entr(ies) checked, none stale`);
      }
      const roots = [
        repoRoot,
        typeof standaloneDir === 'function' ? standaloneDir() : standaloneDir,
        isPackaged ? resourcesPath : null,
      ];
      const sweep = helperReaper.sweepUnledgeredOrphans(roots, { log: logLine });
      if (sweep.reaped && sweep.reaped.length) {
        logLine(`startup sweep: ${sweep.reaped.length} unledgered orphan(s) killed (${sweep.reaped.map((r) => r.pid).join(', ')})`);
      }
    } catch (e) {
      logLine(`startup reap failed: ${e.message}`);
    }
  }

  return {
    scanE2EResidueAtStartup,
    scheduleAutoMemoryIndex,
    sweepOrphanSayProcesses,
    scheduleMcpOrphanReap,
    sweepOrphanHelpers,
  };
}

module.exports = {
  createStartupSweepService,
};
