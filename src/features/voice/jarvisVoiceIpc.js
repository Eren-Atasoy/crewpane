'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

/**
 * ADP-121 / ADP-813 / ADP-814 / ADP-815 / ADP-848 / AGENTX-RT-3
 * Jarvis Voice core IPC yüzeyi (STT, Brain, TTS, Input-Sim, Screen-Capture).
 */
function registerJarvisVoiceIpc({
  ipcMain,
  BrowserWindow,
  getAppWindow = () => null,
  inputSim,
  screenCaptureMod,
  instancePaths,
  agentSettings,
  jarvisVoice,
  REPO_ROOT,
  appI18n,
  grokVoice,
  logLine = () => {},
}) {
  // ADP-265 — Jarvis input simülasyonu: TEK dar kanal (ADR-016). YAPISAL sınır:
  // sendInputEvent olayı yalnız KENDİ webContents'imize enjekte eder.
  const jarvisInputRate = inputSim.makeRateLimiter({});
  ipcMain.handle('jarvis:input-event', (event, raw) => {
    const v = inputSim.validateInputAction(raw);
    if (!v.ok) return { ok: false, error: v.error };
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, error: 'pencere yok' };
    const bounds = win.getContentBounds();
    if (!inputSim.withinBounds(v.action, bounds)) {
      return { ok: false, error: `koordinat pencere dışı (${v.action.x},${v.action.y}) — app-içi sınır` };
    }
    if (!jarvisInputRate.allow()) {
      return { ok: false, error: 'eylem tavanı aşıldı — kısa bir süre sonra tekrar dene (rate-limit)' };
    }
    // Koordinatsız scroll pencere merkezine gider.
    const action = { ...v.action };
    if (action.op === 'scroll' && (action.x === undefined || action.y === undefined)) {
      action.x = Math.round(bounds.width / 2);
      action.y = Math.round(bounds.height / 2);
    }
    try {
      for (const ev of inputSim.toInputEvents(action)) {
        event.sender.sendInputEvent(ev);
      }
      logLine(`jarvis input-sim: ${action.op} ${action.op === 'type' ? `len=${action.text.length}` : `(${action.x ?? '-'},${action.y ?? '-'})`}`);
      return { ok: true, op: action.op };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // ADP-817 (FAZ 5) — EKRAN GÖRÜNTÜSÜ: Agent X'in ikinci main-ipc dar kanalı.
  const jarvisShotRate = inputSim.makeRateLimiter({ max: 6, windowMs: 60000 });
  ipcMain.handle('jarvis:screen-capture', async (_event, raw) => {
    if (!jarvisShotRate.allow()) {
      return { ok: false, reason: 'rate-limit', error: 'çok sık ekran görüntüsü — biraz bekle' };
    }
    const jarvisShots = screenCaptureMod.createScreenCapture({
      dir: path.join(instancePaths.crewpaneHome(), 'agentx-shots'),
      deps: {
        fs,
        execFile,
        log: logLine,
        captureWindow: async () => {
          const win = getAppWindow();
          return win && !win.isDestroyed() ? win.webContents.capturePage() : null;
        },
      },
    });
    const res = await jarvisShots.capture(raw);
    logLine(`jarvis screen.capture: ${res.ok ? `ok ${res.path}` : `red ${res.reason} — ${res.error}`}`);
    return res;
  });

  // ADP-121 (ADR-009 Faz 120a) — Jarvis voice core konfigürasyonu.
  ipcMain.handle('jarvis:config', () => {
    const s = agentSettings.readSettings();
    return {
      ok: true,
      hasOpenAiKey: !!jarvisVoice.openAiKey(REPO_ROOT),
      keyMissingMessage: jarvisVoice.openAiKeyMissingMessage(),
      keyMissingTarget: jarvisVoice.openAiKeySettingsTarget(),
      voice: jarvisVoice.SAY_VOICE,
      voiceLocale: appI18n.voiceLocale(s),
      pushToTalkKey: s.pushToTalkKey,
      wakeModelPath: s.wakeModelPath,
      ttsEngine: (s.jarvis && s.jarvis.ttsEngine) || 'openai',
      tts: jarvisVoice.ttsProviders.ttsConfig(s, { rootDir: REPO_ROOT }),
      ttsVoice: (s.jarvis && s.jarvis.ttsVoice) || jarvisVoice.DEFAULT_TTS_VOICE,
      view: (s.jarvis && s.jarvis.view) || null,
      ttsModel: (s.jarvis && s.jarvis.ttsModel) || jarvisVoice.DEFAULT_TTS_MODEL,
      silenceMs: jarvisVoice.normalizeSilenceMs(s.jarvis && s.jarvis.silenceMs),
      endpointMaxMs: jarvisVoice.normalizeEndpointMaxMs(
        s.jarvis && s.jarvis.endpointMaxMs,
        s.jarvis && s.jarvis.silenceMs,
      ),
      sleepAfterMs: jarvisVoice.normalizeSleepAfterMs(s.jarvis && s.jarvis.sleepAfterMs),
      noSpeechMs: jarvisVoice.normalizeNoSpeechMs(s.jarvis && s.jarvis.noSpeechMs),
      silentSleep: !!(s.jarvis && s.jarvis.silentSleep === true),
      wakeLegacy: !!(s.jarvis && s.jarvis.wakeLegacy === true),
      sttEngine: jarvisVoice.resolveSttEngine(s),
      localStt: jarvisVoice.whisperLocal.status({ settings: s }),
      voiceMode: grokVoice.resolveVoiceMode(s),
      hasXaiKey: grokVoice.hasGrokKey(),
      grok: {
        model: grokVoice.resolveGrokModel(s),
        voice: grokVoice.resolveGrokVoice(s),
        voices: grokVoice.GROK_VOICES,
        models: Object.values(grokVoice.GROK_MODELS),
        cost: grokVoice.grokCostNotice(grokVoice.resolveGrokModel(s)),
        keyMissingMessage: grokVoice.grokKeyMissingMessage(),
        keyMissingTarget: grokVoice.grokKeySettingsTarget(),
      },
    };
  });

  ipcMain.handle('jarvis:voices', () => jarvisVoice.TTS_VOICES);

  // ADP-848 — SESLİ ÖNİZLEME / ELEVENLABS SES LİSTESİ
  ipcMain.handle('jarvis:tts-voice-list', async (_event, payload) => {
    const s = agentSettings.readSettings();
    const engine = payload && payload.engine;
    if (engine && engine !== 'elevenlabs') {
      return { ok: false, reason: 'static-voices', voices: [], status: null };
    }
    return jarvisVoice.ttsProviders.listElevenVoices({ settings: s, ctx: { rootDir: REPO_ROOT } });
  });

  ipcMain.handle('jarvis:tts-preview', (_event, payload) => {
    const s = agentSettings.readSettings();
    const apiKey = jarvisVoice.openAiKey(REPO_ROOT);
    return jarvisVoice.ttsPreview({
      engine: payload && payload.engine,
      voice: (payload && payload.voice) || undefined,
      settings: s,
      apiKey,
      ctx: { rootDir: REPO_ROOT },
    });
  });

  // ADP-813 (Faz 1) — STT transcribe
  ipcMain.handle('jarvis:transcribe', async (_event, payload) =>
    jarvisVoice.withUserMessage(
      await jarvisVoice.transcribeSpeech({
        ...(payload || {}),
        apiKey: jarvisVoice.openAiKey(REPO_ROOT),
        settings: agentSettings.readSettings(),
        log: logLine,
      })));

  // ADP-813 — STT Warmup
  ipcMain.handle('jarvis:sttWarmup', async () => {
    const s = agentSettings.readSettings();
    if (jarvisVoice.resolveSttEngine(s) !== 'local') return { ok: false, reason: 'engine-not-local' };
    jarvisVoice.whisperLocal.warmupDraft({ settings: s, log: logLine }).catch(() => {});
    return jarvisVoice.whisperLocal.ensureServer({ settings: s, log: logLine });
  });

  // ADP-814 (Faz 2) — Kısmi transkript
  let partialLastReason = null;
  const notePartialFailure = (reason, detail) => {
    if (!reason || reason === partialLastReason) return;
    partialLastReason = reason;
    logLine(`[stt:taslak] kısmi hipotez üretilemedi (${reason})${detail ? ' — ' + String(detail).slice(0, 160) : ''} → canlı transkript EKRANDA GÖRÜNMEZ`);
  };

  ipcMain.handle('jarvis:transcribePartial', async (_event, payload) => {
    const s = agentSettings.readSettings();
    if (jarvisVoice.resolveSttEngine(s) !== 'local') {
      notePartialFailure('engine-not-local');
      return { ok: false, reason: 'engine-not-local' };
    }
    const r = await jarvisVoice.whisperLocal.transcribePartial({ ...(payload || {}) }, { settings: s, log: logLine });
    if (r && r.ok && r.text) partialLastReason = null;
    else notePartialFailure((r && r.reason) || 'bilinmeyen', r && r.detail);
    return r;
  });

  // ADP-815 (Faz 3) — Katman 2 Beyin Isıtma & İstatistikleri
  ipcMain.handle('jarvis:brainWarmup', async () => jarvisVoice.warmupBrain());

  ipcMain.handle('jarvis:brainStats', () => jarvisVoice.brainStats());

  ipcMain.handle('jarvis:brainKill', (_e, payload) =>
    ({ ok: jarvisVoice.killBrainForTest((payload && payload.signal) || 'SIGKILL') }));

  ipcMain.handle('jarvis:think', (_event, payload) => jarvisVoice.decide(payload || {}));

  // ADP-812 — Speak
  ipcMain.handle('jarvis:speak', async (_event, payload) => {
    const s = agentSettings.readSettings();
    const apiKey = jarvisVoice.openAiKey(REPO_ROOT);
    const wanted = jarvisVoice.ttsProviders.resolveTtsEngine(s);
    const r = await jarvisVoice.speakWithSettings({ ...(payload || {}), settings: s, apiKey });
    try {
      const spoke = (r && r.engine) || '?';
      const fb = r && r.fallback;
      const st = jarvisVoice.ttsMute.audioOutputStats();
      logLine(
        `tts: istenen=${wanted} konuşan=${spoke} bayt=${(r && r.bytes) || 0} ms=${(r && r.ms) || 0}` +
        ` çıkış=${r && r.muted ? 'yok(susturuldu)' : (r && r.playIn) || 'main'}` +
        ` sayaç[duyulur=${st.audible} bastırılan=${st.suppressed} sentez=${st.synthesized}]` +
        (fb ? ` DÜŞÜLDÜ from=${fb.from} sebep=${fb.reason}` : ''),
      );
      if (fb && fb.detail) logLine(`tts: sağlayıcı yanıtı → ${String(fb.detail).slice(0, 400)}`);
    } catch { /* teşhis log'u ses yolunu ASLA kıramaz */ }
    return r;
  });

  // AGENTX-RT-3 — Akan TTS
  const _speechStreams = new Map(); // streamId → AbortController
  ipcMain.handle('jarvis:speakStream', async (event, payload) => {
    const req = payload || {};
    const streamId = String(req.streamId || `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`);
    const ac = new AbortController();
    for (const [id, prev] of _speechStreams) {
      if (prev.wc === event.sender) {
        try { prev.ac.abort(); } catch { /* zaten bitti */ }
        _speechStreams.delete(id);
      }
    }
    _speechStreams.set(streamId, { ac, wc: event.sender });
    const send = (c) => {
      if (event.sender.isDestroyed()) {
        try { ac.abort(); } catch { /* kapandı */ }
        return;
      }
      event.sender.send('jarvis:speech-chunk', { streamId, ...c });
    };
    let r;
    try {
      r = await jarvisVoice.speakStreamWithSettings({
        text: req.text,
        settings: agentSettings.readSettings(),
        apiKey: jarvisVoice.openAiKey(REPO_ROOT),
        onChunk: send,
        signal: ac.signal,
      });
    } catch (e) {
      r = { ok: false, reason: 'stream-threw', detail: String((e && e.message) || e) };
    } finally {
      _speechStreams.delete(streamId);
    }
    try {
      logLine(
        `tts-akış: id=${streamId} ok=${r && r.ok} sebep=${(r && r.reason) || '-'} ` +
        `önbellek=${r && r.cached ? 'evet' : 'hayır'} ilkBayt=${(r && r.firstByteMs) != null ? r.firstByteMs : '-'}ms ` +
        `bayt=${(r && r.bytes) || 0} parça=${(r && r.emitted) || 0} grup=${(r && r.groups) || 0} ms=${(r && r.ms) || 0}`,
      );
    } catch { /* teşhis log'u ses yolunu ASLA kıramaz */ }
    return { ...r, streamId };
  });

  ipcMain.on('jarvis:speakStreamCancel', (event, streamId) => {
    for (const [id, s] of _speechStreams) {
      if ((streamId && id === streamId) || (!streamId && s.wc === event.sender)) {
        try { s.ac.abort(); } catch { /* zaten bitti */ }
        _speechStreams.delete(id);
      }
    }
  });

  ipcMain.on('jarvis:stopSpeaking', () => jarvisVoice.stopPlayback());
}

module.exports = { registerJarvisVoiceIpc };
