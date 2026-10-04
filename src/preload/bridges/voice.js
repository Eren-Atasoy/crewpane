'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ADP-265 — Jarvis input simülasyonu köprüsü: TEK dar kanal (jarvis:input-event).
// Yalnız app penceresi içi (yapısal — sendInputEvent kendi webContents'imize gider);
// şema/sınır/rate-limit main'de, onay kartı renderer'da (actionBus onay-gerekli).
contextBridge.exposeInMainWorld('jarvisInputSim', {
  run: (action) => ipcRenderer.invoke('jarvis:input-event', action),
});

// ADP-817 — Agent X ekran görüntüsü köprüsü: TEK dar kanal (jarvis:screen-capture).
// Renderer YOL vermez ({scope}) — dosya adı/dizin main'in kararı; dönüş {ok, path, bytes}.
// Onay kartı renderer'da (actionBus 'onay-gerekli' sınıfı).

contextBridge.exposeInMainWorld('jarvisScreenCapture', {
  run: (req) => ipcRenderer.invoke('jarvis:screen-capture', req),
});


contextBridge.exposeInMainWorld('jarvisApi', {
  /** Capability probe → { ok, hasOpenAiKey, voice, claudeBin, voiceMode, grok }. */
  config: () => ipcRenderer.invoke('jarvis:config'),
  /**
   * ADP-827 (Faz 7) — GROK VOICE oturumu. xAI anahtarı MAIN'de kalır: renderer
   * yalnız 16 kHz PCM16 base64 parçası yollar ve olay alır. `audio` bilerek
   * `send` (invoke DEĞİL) — 20 ms'lik parçada yanıt beklemek kuyruk kurar.
   */
  grok: {
    connect: () => ipcRenderer.invoke('grok:connect'),
    audio: (base64) => ipcRenderer.send('grok:audio', base64),
    /** BİZİM cevabımızı söylet (karar bizde kalır — `force_message`). */
    say: (text) => ipcRenderer.invoke('grok:say', text),
    /** Barge-in: modelin yanıtını kes + yoldaki sesi at. */
    interrupt: () => ipcRenderer.invoke('grok:interrupt'),
    /** Oturumu kapat → { ok, usage:{seconds, usd} } (fatura şeffaflığı). */
    close: () => ipcRenderer.invoke('grok:close'),
    status: () => ipcRenderer.invoke('grok:status'),
    /** Sunucu olayları: ready · transcript · audio · error · closed · usage. */
    onEvent: (cb) => {
      const l = (_e, evt) => cb(evt);
      ipcRenderer.on('grok:event', l);
      return () => ipcRenderer.removeListener('grok:event', l);
    },
  },
  /** STT: base64 audio → { ok, text } | { ok:false, reason }. Whisper, main-side. */
  transcribe: (payload) => ipcRenderer.invoke('jarvis:transcribe', payload),
  /**
   * ADP-813 — YEREL STT ISITMA: kayıt BAŞLADIĞI an çağrılır. whisper.cpp sunucusu
   * ayağa kalkarken (~600 ms + model yükleme) kullanıcı zaten konuşuyor → ilk turun
   * soğuk bedeli (ölçüldü 1301 ms → 549 ms) kullanıcının konuşma süresine gizlenir.
   * Ateşle-unut: dönüşü beklenmeden kayıt devam eder.
   */
  warmupStt: () => ipcRenderer.invoke('jarvis:sttWarmup'),
  /**
   * ADP-815 — KATMAN 2 (kalıcı `claude` beyni) ISITMA: kayıt başlarken çağrılır.
   * Soğuk ilk tur 4–13 s, ısınmış tur p50 2.5 s (ÖLÇÜLDÜ) → bedel kullanıcının
   * konuşma süresine gizlenir. Ateşle-unut; oturum kurulamazsa karar zinciri
   * soğuk `claude -p` yoluna düşer.
   */
  warmupBrain: () => ipcRenderer.invoke('jarvis:brainWarmup'),
  /** ADP-815 — gözcü durumu (e2e/ölçüm): { alive, ready, turns, coldFallbacks, rssMb }. */
  brainStats: () => ipcRenderer.invoke('jarvis:brainStats'),
  /** ADP-815 — kalıcı oturumu KASTEN öldür (çökme→soğuk-yol testinin kaçış kapısı). */
  brainKill: (payload) => ipcRenderer.invoke('jarvis:brainKill', payload),
  /**
   * ADP-814 — AKIŞ STT: kayıt SÜRERKEN o ana kadarki kümülatif ses → hızlı `base`
   * modelinden kısmi hipotez (ölçüldü p50 ~136 ms). Yalnız EKRANA yazılır; komut
   * olarak asla çalıştırılmaz. Yerel yol kapalıysa sebep döner (bulut kullanılmaz).
   */
  transcribePartial: (payload) => ipcRenderer.invoke('jarvis:transcribePartial', payload),
  /**
   * ADP-816 (Faz 4) — TAŞINABİLİR SES WIDGET'I (ayrı, frameless, always-on-top
   * pencere). Bu köprü YALNIZ pencere + görüntü taşır: ses/kayıt/karar zincirine
   * hiçbir ucu dokunmaz. Widget penceresinin renderer'ı da AYNI preload'u yükler,
   * yani `snapshot`/`onChanged`/`move` uçlarını oradan çağırır.
   */
  widget: {
    /** Widget penceresini aç (odak ÇALMAZ — main showInactive kullanır). */
    open: () => ipcRenderer.invoke('jarvisWidget:open'),
    close: () => ipcRenderer.invoke('jarvisWidget:close'),
    toggle: () => ipcRenderer.invoke('jarvisWidget:toggle'),
    isOpen: () => ipcRenderer.invoke('jarvisWidget:isOpen'),
    /** ANA pencere → main: ses yüzeyinin son durumu (durum, kısmi metin, son çift). */
    publish: (snapshot) => ipcRenderer.invoke('jarvisWidget:publish', snapshot),
    /** WIDGET penceresi → main: mount'ta son fotoğraf (boş açılmasın). */
    snapshot: () => ipcRenderer.invoke('jarvisWidget:snapshot'),
    /** WIDGET penceresi: sürükleme deltası (frameless pencerenin taşınma yolu). */
    move: (delta) => ipcRenderer.invoke('jarvisWidget:move', delta),
    /** WIDGET penceresi: ana pencereyi göster/yeniden yarat (kullanıcı tıklaması). */
    showApp: () => ipcRenderer.invoke('jarvisWidget:showApp'),
    /** e2e/ölçüm: pencerenin GERÇEK bayrakları (alwaysOnTop/focusable/bounds). */
    debug: () => ipcRenderer.invoke('jarvisWidget:debug'),
    /** WIDGET penceresi: durum fotoğrafı değişti. Returns unsubscribe. */
    onChanged: (cb) => {
      const l = (_e, snapshot) => cb(snapshot);
      ipcRenderer.on('jarvisWidget:changed', l);
      return () => ipcRenderer.removeListener('jarvisWidget:changed', l);
    },
    /** ANA pencere: widget açıldı/kapandı (düğme gerçeği yansıtsın). */
    onOpenState: (cb) => {
      const l = (_e, payload) => cb(payload);
      ipcRenderer.on('jarvisWidget:openState', l);
      return () => ipcRenderer.removeListener('jarvisWidget:openState', l);
    },
  },
  /** Brain: { transcript, context } → { ok, decision, via } (claude or rule). */
  think: (payload) => ipcRenderer.invoke('jarvis:think', payload),
  /** TTS: { text, play? } → { ok, path, bytes, ms } | { ok:false }. Uses settings engine. */
  speak: (payload) => ipcRenderer.invoke('jarvis:speak', payload),
  /** Preview a specific TTS voice with a sample sentence. { voice } → { ok, ... }. */
  preview: (payload) => ipcRenderer.invoke('jarvis:tts-preview', payload),
  /** List available TTS voices → string[]. */
  voices: () => ipcRenderer.invoke('jarvis:voices'),
  /**
   * ADP-848-B — ElevenLabs ses listesi KULLANICININ hesabından çekilir
   * ({ engine:'elevenlabs' } → { ok, voices, counts, status }). Sır DÖNMEZ.
   * Anahtar yoksa/çağrı patlarsa `status` ne olduğunu Türkçe söyler.
   */
  voiceList: (payload) => ipcRenderer.invoke('jarvis:tts-voice-list', payload),
  /**
   * AGENTX-RT-3 — AKAN TTS. `speak` SON baytı bekler; bu İLK baytı yollar.
   * Dönüş özet ({ ok, cached, firstByteMs, bytes, groups, ms }); ses PARÇALARI
   * `onSpeechChunk` ile akar. Önbellekte varsa akış YOKTUR ve `audioBase64`
   * doğrudan döner (ADP-812 yolu korunur).
   * Eski preload'larda YOK → çağıran `?.` ile korur: köprü yoksa ses sessizce
   * eski (bekleyen) yoldan çıkar, zincir kırılmaz.
   */
  speakStream: (payload) => ipcRenderer.invoke('jarvis:speakStream', payload),
  /** Akan TTS'in PCM parçaları ({ streamId, index, base64, rate, first }). Returns unsubscribe. */
  onSpeechChunk: (cb) => {
    const l = (_e, chunk) => cb(chunk);
    ipcRenderer.on('jarvis:speech-chunk', l);
    return () => ipcRenderer.removeListener('jarvis:speech-chunk', l);
  },
  /** Akan TTS'i kes: yoldaki HTTP isteği de iptal edilir (jeton/bant yanmaz). */
  cancelSpeakStream: (streamId) => ipcRenderer.send('jarvis:speakStreamCancel', streamId),
  /** Barge-in / Esc — stop any in-flight playback. */
  stopSpeaking: () => ipcRenderer.send('jarvis:stopSpeaking'),
  // ADP-317 — KONUŞMA DEFTERİ (tek gerçek main'de). Panel de telefon da buradan
  // beslenir: masaüstünde yazılan satır telefona, telefondan gelen satır panele düşer.
  conv: {
    /** Defterin tamamı → { turns, approvals } (mount'ta hydrate; restart'ı atlatır). */
    get: () => ipcRenderer.invoke('jarvis:conv:get'),
    /** Satır ekle → { id, who, text, source, action, at } (idempotent: aynı id yok sayılır). */
    append: (turn) => ipcRenderer.invoke('jarvis:conv:append', turn),
    /** Onay kartı aç — İKİ uçta birden görünür. */
    openApproval: (approval) => ipcRenderer.invoke('jarvis:conv:approval', approval),
    /** Onayı kapat. null dönerse: BAŞKA uç zaten cevaplamış (çift çalıştırma yok). */
    resolve: (payload) => ipcRenderer.invoke('jarvis:conv:resolve', payload),
    clear: () => ipcRenderer.invoke('jarvis:conv:clear'),
    /** Defter değişti (satır/onay/çözüm) → canlı akış. Returns unsubscribe. */
    onChanged: (cb) => {
      const l = (_e, event) => cb(event);
      ipcRenderer.on('jarvis:conv:changed', l);
      return () => ipcRenderer.removeListener('jarvis:conv:changed', l);
    },
  },
  /** Global hotkey (toggle activation) pushed from main. Returns unsubscribe. */
  onHotkey: (cb) => {
    const l = () => cb();
    ipcRenderer.on('jarvis:hotkey', l);
    return () => ipcRenderer.removeListener('jarvis:hotkey', l);
  },
  /**
   * AXP-03 — AGENT X'TEN AJANA PROMPT TESLİMİ + MAKBUZ. Teslim MAIN'de yapılır
   * (ENT-F1 primitifi + transcript hükmü); renderer yalnız taslağı verir, makbuzu alır.
   * `deliver` AXP-02'nin `draft:confirmed`ını taşır: { from:{userId?,surface,kind}, target:
   * {agentId?|role?|teamId?|text?}, text, digest?, revision?, ctx:{aliases,departments,
   * activeDepartment} } → { ok:true, receipt } | { ok:false, kind:'ambiguous'|'unknown'|
   * 'denied'|'no-text'|'digest-mismatch', … }. Makbuz gövdeyi TAŞIMAZ (yalnız digest).
   * Eski preload'larda YOK → çağıran `?.` ile korur.
   */
  agentx: {
    deliver: (req) => ipcRenderer.invoke('agentx:deliver', req),
    /** Teslimsiz hedef çözümü (HEDEF SORUSU'ndan önce): { target, ctx } → resolveTarget çıktısı. */
    resolve: (req) => ipcRenderer.invoke('agentx:resolve', req),
    /** AXP-14 — uçuş-öncesi yoklama (yazmaz): { target, ctx } → { resolved, pane, state: idle|busy|menu|fresh|text|none }. */
    probe: (req) => ipcRenderer.invoke('agentx:probe', req),
    /** "Son işlemler" — oturum içi makbuz defteri (en yeni önde). */
    receipts: () => ipcRenderer.invoke('agentx:receipts'),
    retry: (id) => ipcRenderer.invoke('agentx:retry', id),
    cancel: (id) => ipcRenderer.invoke('agentx:cancel', id),
    /** Makbuz üretildi/değişti (ana pencere + pop-out aynı olayı dinler). Returns unsubscribe. */
    onReceipt: (cb) => {
      const l = (_e, receipt) => cb(receipt);
      ipcRenderer.on('agentx:receipt', l);
      return () => ipcRenderer.removeListener('agentx:receipt', l);
    },
    // ── AXP-04 — IŞIK ─────────────────────────────────────────────────────────
    /** Kaynak ölçümü: {orbCss} (ana pencere CSS px) → {ok, mode, origin, drawOrigin, overlay, mainContent, mainZoom}. */
    beamSource: (p) => ipcRenderer.invoke('agentx:beam:source', p),
    /** Pencere DIŞI parça için masaüstü katmanı (yalnız macOS + popout-outside). */
    beamShow: (seg) => ipcRenderer.invoke('agentx:beam:show', seg),
    beamClear: () => ipcRenderer.invoke('agentx:beam:clear'),
    /** POP-OUT penceresi: main gösterge dikdörtgenini ister; cevap `beamMeasured` ile. Returns unsubscribe. */
    onBeamMeasure: (cb) => {
      const l = (_e, p) => cb(p);
      ipcRenderer.on('agentx:beam:measure', l);
      return () => ipcRenderer.removeListener('agentx:beam:measure', l);
    },
    beamMeasured: (p) => ipcRenderer.send('agentx:beam:measured', p),
  },
});

// HAND-A1 — "EL KONTROLÜ" EKRAN ÜSTÜ GÖRSELLEŞTİRME KATMANI köprüsü.
// İki tüketicisi var: (1) overlay penceresinin renderer'ı (init/onEvents/
// onConfig/cost); (2) tespit kaynağı — D döngüsünün gizli penceresi ya da dev
// besleyici (feed). Kamera görüntüsü bu köprüden GEÇEMEZ: yalnız normalize
// telemetri olayları taşınır (şekil nöbeti main'de, handOverlayContract.cjs).
