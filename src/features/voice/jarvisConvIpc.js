'use strict';

/**
 * Jarvis Conversation defteri IPC yüzeyi
 */
function registerJarvisConvIpc({
  ipcMain,
  jarvisConv,
  getJarvisConv = () => jarvisConv,
}) {
  ipcMain.handle('jarvis:conv:get', () => getJarvisConv().snapshot());

  ipcMain.handle('jarvis:conv:append', (_e, turn) => getJarvisConv().appendTurn(turn || {}));

  ipcMain.handle('jarvis:conv:approval', (_e, approval) => getJarvisConv().openApproval(approval || {}));

  /**
   * Tek kazanan: kapalı onayı ikinci kez kapatmak null döner → çağıran çalıştırmaz.
   * ADP-322 — `choice` (fan-out kartının çıkışı) de tek-kazanan kapısından geçer.
   */
  ipcMain.handle('jarvis:conv:resolve', (_e, p) =>
    getJarvisConv().closeApproval((p || {}).approvalId, (p || {}).decision, (p || {}).choice),
  );

  ipcMain.handle('jarvis:conv:clear', () => {
    getJarvisConv().clear();
    return { ok: true };
  });
}

module.exports = { registerJarvisConvIpc };
