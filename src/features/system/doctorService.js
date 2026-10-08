'use strict';

const defaultOs = require('node:os');
const defaultFirstRunDoctor = require('../../agents/firstRunDoctor.cjs');
const defaultCrewpaneEnv = require('../../config/crewpaneEnv.cjs');
const defaultInstancePaths = require('../../config/instancePaths.cjs');

/**
 * Creates the Doctor Service for system diagnostics and hook scanning (ADP-625, ADP-907).
 */
function createDoctorService({
  firstRunDoctor = defaultFirstRunDoctor,
  crewpaneEnv = defaultCrewpaneEnv,
  instancePaths = defaultInstancePaths,
  os = defaultOs,
  getSeatGate = () => null,
  getRendererSupabaseTarget = () => ({}),
  getEnvLayerView = () => ({}),
  getIdentityMode = () => 'anon',
  getAgentWorkspaceRoot = () => null,
  getWorkspaceStatus = () => ({}),
  getSecretBackend = () => null,
  checkEngines = () => ({}),
} = {}) {
  /**
   * ADP-907 — YABANCI KANCA taramasının GİRDİLERİ (salt-okunur).
   * userHome: kullanıcının GERÇEK ev dizini (~/.claude/settings.json orada yaşar).
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

  /**
   * ADP-625 — İlk açılış doktorunu ÇALIŞTIR (tek yer: hem IPC hem açılış logu).
   */
  async function runDoctorNow() {
    let account = null;
    try {
      const seat = typeof getSeatGate === 'function' ? getSeatGate() : getSeatGate;
      account = seat ? seat.evaluate() : null;
    } catch {
      account = null;
    }

    return firstRunDoctor.runFirstRunDoctor({
      userHome: hookScanHome(),
      env: hookProbeEnv(),
      home: instancePaths.crewpaneHome(),
      deviceHome: instancePaths.instanceHome(),
      backend: typeof getRendererSupabaseTarget === 'function' ? getRendererSupabaseTarget() : getRendererSupabaseTarget,
      envView: typeof getEnvLayerView === 'function' ? getEnvLayerView() : getEnvLayerView,
      identityMode: typeof getIdentityMode === 'function' ? getIdentityMode() : getIdentityMode,
      account,
      checkEngines: typeof checkEngines === 'function' ? checkEngines : () => ({}),
      workspaceRoot: typeof getAgentWorkspaceRoot === 'function' ? getAgentWorkspaceRoot() : getAgentWorkspaceRoot,
      workspaceStatus: typeof getWorkspaceStatus === 'function' ? getWorkspaceStatus() : getWorkspaceStatus,
      secretBackend: typeof getSecretBackend === 'function' ? getSecretBackend() : getSecretBackend,
    });
  }

  function formatDoctorLog(report) {
    return firstRunDoctor.formatDoctorLog(report);
  }

  return {
    hookScanHome,
    hookProbeEnv,
    runDoctorNow,
    formatDoctorLog,
    firstRunDoctor,
  };
}

module.exports = {
  createDoctorService,
};
