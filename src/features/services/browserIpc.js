'use strict';

/**
 * Headed Browser Automation IPC Handlers (Faz 3.5 — Sıra 3)
 * Channels: browser:action, browser:stop, browser:trust:automation, browser:trust:status,
 *           browser:setActiveGuest, browser:setTabOwner
 */
function registerBrowserIpc({
  ipcMain,
  runBrowserAction,
  browserGate,
  browserGuests,
  isOwnedGuest,
  guestOwners,
  setAppWindowGuest = () => {},
  getAppWindowGuest = () => null,
  agentGuests,
  lastUnownedGuest,
  logLine = () => {},
}) {
  ipcMain.handle('browser:action', (_event, value) => runBrowserAction(value || {}));
  ipcMain.handle('browser:stop', () => browserGate().stopAll());

  ipcMain.handle('browser:trust:automation', (_event, payload) => {
    const minutes = payload && payload.minutes;
    return browserGate().setAutomation(minutes);
  });
  ipcMain.handle('browser:trust:status', () => browserGate().automation());

  ipcMain.on('browser:setActiveGuest', (_event, id) => {
    const guest = browserGuests.get(id);
    if (!guest || guest.isDestroyed()) return;
    if (isOwnedGuest(id)) {
      logLine(`[adp396] aktif sekme ajanın (${guestOwners.get(id)}) → İNSAN yolu hedefi DEĞİŞMEDİ`);
      return;
    }
    setAppWindowGuest(guest);
    logLine('webview active tab → İNSAN yolu hedefi id=' + id);
  });

  ipcMain.on('browser:setTabOwner', (_event, payload) => {
    const id = payload && payload.guestId;
    const agentId = payload && typeof payload.agentId === 'string' ? payload.agentId.trim() : '';
    const guest = browserGuests.get(id);
    if (!guest || guest.isDestroyed() || !agentId) return;
    guestOwners.set(id, agentId);
    agentGuests.set(agentId, guest);
    logLine(`browser tab owner: ${agentId} → guest id=${id}`);
    if (getAppWindowGuest() === guest) {
      const fallback = lastUnownedGuest();
      setAppWindowGuest(fallback);
      logLine(
        `[adp396] insan hedefi ajan sekmesine kaçmıştı → geri alındı (hedef=${fallback ? fallback.id : 'YOK'})`,
      );
    }
  });
}

module.exports = { registerBrowserIpc };
