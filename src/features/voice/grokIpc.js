'use strict';

/**
 * ADP-827 (Faz 7) — GROK VOICE OTURUMU IPC YÜZEYİ
 *
 * Anahtar MAIN'de kalır (ADP-628): WebSocket'i main açar, renderer yalnız ses
 * baytı yollar ve olay alır. Oturum TEK: ikinci `connect` öncekini kapatır —
 * aksi hâlde unutulan bir soket DAKİKA ÜCRETİ yazdırmaya devam ederdi.
 *
 * 🔴 MALİYET SINIRI: oturum yalnız UYANIK modda açık durur. Uyandırma kelimesi
 * YEREL (ücretsiz) kalır — 7/24 ses akıtmak ADP-804'te ölçülen 61–203 USD/ay'lık
 * tabloyu üretirdi. Kapanış yolu bu yüzden `grok:close` ve uyku olayına bağlıdır.
 */
function registerGrokIpc({
  ipcMain,
  app,
  BrowserWindow,
  agentSettings,
  grokVoice,
  jarvisVoice,
  logLine = () => {},
}) {
  let grokSession = null;

  const grokBroadcast = (evt) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (!w.isDestroyed()) w.webContents.send('grok:event', evt);
      } catch {
        /* kapanan pencere */
      }
    }
  };

  const grokTeardown = (reason) => {
    if (!grokSession) return null;
    const usage = grokSession.usage();
    try {
      grokSession.close();
    } catch {
      /* zaten kapalı */
    }
    grokSession = null;
    // Fatura şeffaflığı: her kapanışta ne kadar sürdü + tahmini kaç USD.
    logLine(`grok: oturum kapandı reason=${reason} sn=${usage.seconds.toFixed(1)} usd≈${usage.usd.toFixed(4)}`);
    grokBroadcast({ type: 'usage', ...usage, reason });
    return usage;
  };

  ipcMain.handle('grok:connect', async () => {
    const s = agentSettings.readSettings();
    if (grokVoice.resolveVoiceMode(s) !== grokVoice.VOICE_MODE_GROK) {
      // Mod kapalıyken bağlanmak = kullanıcının seçmediği bir ücreti başlatmak.
      return { ok: false, reason: 'mode-off', message: 'Ses modu "Grok Voice" değil.' };
    }
    grokTeardown('reconnect');
    try {
      grokSession = grokVoice.createGrokSession({
        settings: s,
        // CREWPANE_GROK_URL: yalnız yerel prova (mock sunucu) içindir; boşsa xAI.
        url: process.env.CREWPANE_GROK_URL || undefined,
        silenceMs: jarvisVoice.normalizeSilenceMs(s.jarvis && s.jarvis.silenceMs),
        onEvent: grokBroadcast,
        log: logLine, // sır ASLA geçmez (grokVoice içinde testli)
      });
      const info = await grokSession.connect();
      return { ok: true, ...info };
    } catch (err) {
      grokSession = null;
      // Anahtar yoksa kapının KENDİ metni gider (sessiz başarısızlık yasak).
      const cred = err && err.code === 'ERR_CREDENTIAL_REQUIRED';
      return {
        ok: false,
        reason: cred ? 'no-xai-key' : 'connect-failed',
        message: cred ? err.userMessage : String((err && err.message) || err),
        credential: cred ? 'xai' : undefined,
        credentialTarget: cred ? grokVoice.grokKeySettingsTarget() : undefined,
      };
    }
  });

  // Ses akışı `send` (invoke DEĞİL): 20 ms'de bir gelen parçada yanıt beklemek
  // kuyruk kurar. Kayıp bir parça turu bozmaz, geciken bir parça bozar.
  ipcMain.on('grok:audio', (_event, base64) => {
    if (grokSession) grokSession.appendAudio(base64);
  });

  ipcMain.handle('grok:say', (_event, text) => ({ ok: !!(grokSession && grokSession.say(text)) }));

  ipcMain.handle('grok:interrupt', () => ({ ok: !!(grokSession && grokSession.interrupt()) }));

  ipcMain.handle('grok:close', () => ({ ok: true, usage: grokTeardown('close') }));

  ipcMain.handle('grok:status', () => ({
    ok: true,
    active: !!grokSession,
    snapshot: grokSession ? grokSession.snapshot() : null,
    usage: grokSession ? grokSession.usage() : null,
  }));

  // Uygulama kapanırken açık kalan oturum = boşa yanan dakika ücreti.
  if (app && typeof app.on === 'function') {
    app.on('before-quit', () => grokTeardown('quit'));
  }

  return {
    getGrokSession: () => grokSession,
    grokTeardown,
  };
}

module.exports = { registerGrokIpc };
