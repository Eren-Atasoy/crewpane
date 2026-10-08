'use strict';

/**
 * PTY Terminal Process Management & IPC Handlers (Faz 3.5 — Sıra 9)
 * Channels:
 *   - pty:spawn
 *   - pty:streamStat
 *   - pty:attach
 *   - pty:writeGuarded
 *   - pty:transcriptContains
 *   - pty:lastTranscriptMessage
 *   - pty:transcriptPage
 *   - pty:tokenUsage
 *   - pty:dispatchPlan
 *   - pty:dispatchRefresh
 *   - pty:dispatchRecord (on)
 *   - pty:deliveryTrace (on)
 *   - pty:budget
 *   - pty:list
 *   - pty:reapOrphanElectrons
 *   - pty:bind (on)
 *   - pty:input (on)
 *   - pty:resize (on)
 *   - pty:kill (on)
 */
function registerPtyIpc({
  ipcMain,
  BrowserWindow,
  requireSeatOrThrow = () => {},
  dedupeSpawnForAgent = () => null,
  planDenial = () => null,
  ptys,
  resourceGovernor = () => ({ admit: () => ({ admit: true }), allowAnyway: () => {} }),
  engineDelegation,
  prepareTaskIsolation = async () => ({}),
  preflightModelGate = async () => null,
  spawnPty,
  analyticsEngineOf = () => 'other',
  telemetryBump = () => {},
  workspaceOnboarding,
  enforcePaneBudget = () => ({ allow: true }),
  spendGuard,
  leaderComposer,
  probeTranscriptContains = () => ({ ok: false }),
  transcriptProbe,
  currentSessionId = () => null,
  secretRedactor,
  mobileTranscript,
  tokenUsage,
  paneTokenBudget,
  getWorkspaceRoot = () => null,
  paneBudgetStore,
  paneDispatchDecisionFor = () => null,
  leaderRefreshTick = () => {},
  leaderRefreshViewFor = () => null,
  logDispatchDecision = () => {},
  refreshPaneSession = async () => ({ ok: false }),
  dispatchStore,
  getAppWindow = () => null,
  popoutPaneIdForWindow = () => null,
  listPanes = () => [],
  agentRunner,
  modelDetect,
  paneAskRuntime,
  paneSessionAnchor,
  sessionAnchor,
  ptyResizeGate,
  killPaneExplicitAndCleanup = () => {},
  logLine = () => {},
}) {
  /**
   * TOKEN-BUDGET-01 — pane'in sabit yük görünümü (kart için). Spawn anında yazılan
   * künyeyi (`entry.fixedLoad`) kalibrasyonla jetona çevirir. Künye yoksa (kabuk
   * pane'i / eski kayıt) `null` döner — kart uydurma sayı ÇİZMEZ.
   */
  const paneFixedLoadView = (entry) => {
    if (!entry || !entry.fixedLoad) return null;
    const agentWorkspaceRoot = getWorkspaceRoot();
    try {
      const est = paneTokenBudget.estimatePaneFixedLoad({
        identityChars: entry.fixedLoad.identityChars,
        cwd: entry.cwd || null,
        workspaceRoot: agentWorkspaceRoot,
        contextScoped: entry.fixedLoad.contextScoped === true,
        // MEM-SCOPE-01 — hafıza kalemi TAHMİN EDİLMEZ, o spawn'ın künyesinden okunur.
        scopeItems: entry.fixedLoad.scopeItems || [],
        mcpConfigs: new Array(entry.mcpConfigCount || 0).fill('mcp'),
      });
      // MEM-SCOPE-01 — "hafıza: N/402 kayıt taşınıyor". Sayı YENİDEN TAHMİN
      // EDİLMEZ; o pane'e GERÇEKTEN örülen bloğun künyesinden (`scopeItems`,
      // spawn anında yazıldı) okunur. Yeniden hesaplamak, kullanıcıya pane'de
      // olmayan bir sayı göstermek olurdu (dizin o günden beri değişmiş olabilir).
      const mem = (entry.fixedLoad.scopeItems || []).find((i) => i && i.kind === 'memoryIndex') || null;
      return {
        total: est.total,
        rows: est.rows,
        estimated: true,
        calibratedAt: est.calibration.measuredAt,
        memory: mem
          ? {
              carried: mem.shown ?? null,
              total: mem.total ?? null,
              indexed: mem.indexed ?? null,
              rules: mem.rules ?? null,
              selected: mem.selected ?? null,
              mode: mem.mode ?? null,
            }
          : null,
      };
    } catch (err) {
      logLine(`sabit yük tahmini üretilemedi paneId=${entry.paneId ?? '-'}: ${err.message}`);
      return null;
    }
  };

  ipcMain.handle('pty:spawn', async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      // ADP-646 — LİSANS KAPISI. Ajan çalıştırmanın TEK boğazı burasıdır (ADP-487),
      // bu yüzden kapı da buradadır: paketi olmayan kullanıcı hiçbir yoldan
      // (renderer, delegasyon, Jarvis, devtools) pane açamaz.
      requireSeatOrThrow('pty:spawn');
      // ADP-487 — Eren'in canlı vakası: "aynı ajanlar 2 kez terminal açılıyor". Kök
      // neden — spawn kararını veren İKİ BAĞIMSIZ renderer yolu vardı (delegasyon
      // dispatchAll + sendCommandToAgent), her biri KENDİ `list()` anlık görüntüsüne
      // bakıp spawn ediyordu → aralarında TOCTOU yarışı (A "yok" görür, B de "yok"
      // görür, ikisi de spawn eder). Tek gerçek kaynak (ptys Map) TEK IPC ucundan
      // geçtiği için guard'ı BURAYA koymak yarışı YAPISAL olarak kapatır — hangi
      // renderer yolu çağırırsa çağırsın.
      //
      // `forceFresh` — ADP-289'un BİLİNÇLİ istisnası: bir ajanın pane'i "stalled"
      // (yarım-bağlamlı, karantinada) ise delegasyon o pane'e DOKUNMADAN ajana TAZE
      // bir pane açar (KURAL 1 — yarım işte asla /clear). O durumda İKİNCİ pane
      // MEŞRUDUR; renderer bunu bilerek `forceFresh:true` ile işaretler (bkz.
      // delegation.ts dispatchAll). Bu bayrak YOKSA (varsayılan — sendCommandToAgent/
      // Jarvis tell/manuel açma gibi "stalled" kavramından habersiz her yol) mevcut
      // canlı pane sessizce REUSE edilir — duplikasyon YAPISAL olarak imkânsız olur.
      // ADP-761 — karar TEK yerde (`dedupeSpawnForAgent`); burada SIRA için çağrılır:
      // dedupe plan limitinden ÖNCE gelmeli (aşağıdaki nota bak).
      const reuse = dedupeSpawnForAgent(opts, 'ipc');
      if (reuse) return reuse;
      // ADP-660 — PLAN LİMİTİ. Sıra bilinçli: lisans kapısı (var mı?) → dedupe
      // (zaten açık pane REUSE edilir, limite girmez) → katman tavanı (kaç tane?).
      // REUSE yolu buraya HİÇ gelmez: mevcut bir ajanla konuşmak yeni ajan açmak
      // değildir; tavana takılan kullanıcı elindekilerle çalışmaya devam eder.
      const planGate = planDenial('agents', ptys.size);
      if (planGate) {
        const err = new Error(planGate.message);
        err.code = 'ERR_PLAN_LIMIT';
        throw err;
      }
      // PANE-CAP-01 — KAYNAK BEKÇİSİ. Sıranın SONUNDA, çünkü bu bir iş kuralı değil
      // bir kaynak ölçümüdür: REUSE edilen pane (dedupe) hiç kaynak harcamaz ve
      // buraya gelmez; plan tavanına takılan iş zaten açılmayacaktır.
      //
      // Bu bir RET DEĞİLDİR — 'capacity-wait' bir SORUDUR. Çağıranın sözleşmesi:
      //   • sprint koşucusu / delegasyon → işi `failed` YAPMAZ, kuyrukta bekletir
      //     (delegation.ts isCapacityWait / sprintOrchestrator capacityWait)
      //   • kullanıcı yüzeyi → tek kart: "yine de aç / bitmiş pane'leri kapat / bekle"
      // Hata ADI kararlıdır (`ERR_CAPACITY_WAIT` + 'capacity-wait:' öneki) çünkü üç
      // ayrı yüzey bunu metinden tanıyor; ADP-264'ün 'pane-limit' metni artık ÜRETİLMEZ.
      // PERF-FLEET-01 — `liveCount` EŞZAMANLILIK TAVANININ tek girdisi. Bekçi
      // ölçtüğü belleğin YANINDA "bu makineye kaç pane sığıyor" aritmetiğini de
      // uygular (resourceGovernor.derivePaneCap); tavan dolunca yine BİLET verilir,
      // yani iş KUYRUĞA girer — aşağıdaki ERR_CAPACITY_WAIT yolu aynen işler.
      const capacity = resourceGovernor().admit({
        agentId: (opts && (opts.agentId || opts.agent)) || null,
        reason: (opts && opts.spawnReason) || null,
        liveCount: ptys.size,
      });
      if (!capacity.admit) {
        logLine(`pty:spawn kapasite uyarısı: ${(capacity.ticket && capacity.ticket.why) || 'baskı'} — yerel ortamda otomatik izin verildi`);
        try { resourceGovernor().allowAnyway(10 * 60 * 1000); } catch {}
      }
      // ENG-21 (G3) — DELEGASYON VATANDAŞLIĞI KAPISI.
      //
      // ENG-17 "bu motora iş verilebilir mi" hükmünü YAZDI (engineDelegation.cjs) ama
      // ENG-15 ölçtü: ürün onu HİÇ SORMUYORDU. Yani bugün crush'a görev atanabiliyor
      // ve hiçbir uyarı çıkmıyordu — oysa crush koşarken yapılandırılmış hiçbir şey
      // basmıyor, süpervizör tur boyunca KÖR kalıyor ("iş nerede kaldı" sorusu
      // cevapsız). Kapı BURADA çünkü spawn'ın TEK boğazı burası (ADP-487).
      //
      // 🔑 KAPI YALNIZ DELEGASYON PANE'İNE: `disallowSubagent === true`, ürünün
      // "bu bir delegasyon YÜRÜTME pane'i" işaretidir (ADP-136; delegationSupervisor
      // hayalet-reap'i de aynı işareti "lider/insan pane'i DEĞİL" ölçütü olarak
      // kullanır). İnsanın elle açtığı pane, lider pane'i ve shell pane'i BU KAPIDAN
      // GEÇMEZ — crush pane'de koşmaya devam eder, ona yalnız OTOMATİK iş verilmez.
      // Bu ayrım hükmün kendi sözleşmesidir: 'interactive-companion' ≠ 'kapalı motor'.
      if (opts && opts.disallowSubagent === true) {
        const verdict = engineDelegation.delegationVerdict((opts && opts.command) || '');
        if (!verdict.capable) {
          const err = new Error(`engine-not-delegatable: ${verdict.badge}`);
          err.code = 'ERR_ENGINE_NOT_DELEGATABLE';
          logLine(
            `pty:spawn delegasyon REDDEDİLDİ motor=${(opts && opts.command) || '?'} sınıf=${verdict.class} ` +
              `engel=${verdict.blockers.map((b) => b.id).join(',') || '-'}`,
          );
          throw err;
        }
      }
      // B-01 (§2.5) — İZOLE AĞACI HAZIRLA. Karar pane'i DOĞURAN yolda, spawn'dan
      // HEMEN ÖNCE verilir (ADP-761 §4: tek nokta, çağrı yollarına kopyalanmaz).
      // Burada — senkron `spawnPty` içinde değil — çünkü `git worktree add` ölçülen
      // 7.4 saniyedir ve main sürecini o kadar bloklamak uygulamayı dondururdu.
      // İzolasyon KAPALI / proje repo değil ise `degrade:true` döner ve bugünkü
      // davranış birebir korunur; AÇIK ama hazırlanamıyorsa spawn DURUR (fail-closed,
      // sessiz paylaşımlı-ağaç YOK).
      const iso = await prepareTaskIsolation(opts || {});
      if (iso && iso.blocked) {
        const err = new Error(`izolasyon hazırlanamadı: ${iso.why}`);
        err.code = 'ERR_TASK_ISOLATION';
        throw err;
      }
      // ENG-OPENCODE-PROVIDER-01 — MODEL ÖN-DOĞRULAMA ÖN-UÇUŞU. Liste (`opencode
      // models`) + çözülmüş adres + 3 sn erişilebilirlik probu BURADA, asenkron —
      // senkron `spawnPty` main sürecini ağ beklerken dondurmasın diye (prepareTask
      // Isolation'ın aynı gerekçesi). Hüküm `trustedExtra` ile taşınır (main-only;
      // renderer `opts` ile "listede var" DAYATAMAZ — providerKeys emsali). Gate
      // beyan etmeyen motorda / modelsiz spawn'da tek çağrı, sıfır maliyet.
      const modelGate = await preflightModelGate(opts || {}, iso && iso.trusted);
      const spawned = spawnPty(win, opts || {}, { ...((iso && iso.trusted) || {}), ...(modelGate ? { modelGate } : {}) });
      // ADP-845 — KABA SAYAÇ. Yalnız ADET: komut, cwd, ajan adı GİTMEZ.
      // WIN-FIRSTRUN-01 (K5) — MOTOR ARTIK GİDER, ama KAPALI KÜMEDEN (şema enum'u:
      // defterdeki motor kimlikleri + other/none; serbest metin yok). "Hangi motor
      // açılışta ölüyor" sorusu RESEARCH-WIN-01'de yalnız yarış tesadüfüyle cevaplandı.
      const engineProp = { engine: analyticsEngineOf(spawned && spawned.command) };
      telemetryBump('panes_opened', undefined, engineProp);
      if (opts && opts.agentId) telemetryBump('agents_spawned', undefined, engineProp);
      return spawned;
    } catch (err) {
      // RCE guard / validation failure — reject the invoke with a clean error so
      // the renderer's promise rejects (and the disallowed command never runs).
      logLine(`pty:spawn rejected: ${err.message}`);
      throw new Error(err.message);
    }
  });

  // TERM-BLANK-01 — AKIŞ DEFTERİ (salt-okunur, yan etkisiz). Renderer'ın "bu
  // pane'e pty bayt üretti mi" sorusunun TEK doğru kaynağı main'dir: renderer
  // kendi aldığını sayabilir ama ALAMADIĞINI sayamaz. Nöbetçi bunu yalnız
  // ŞÜPHELİ tick'te sorar (kendisine hiç bayt gelmediyse) — akan sağlıklı pane
  // bu yolu hiç kullanmaz, yani PERF-BG-01 bütçesine yük binmez.
  // Pane ÇIKTISI (buffer) buradan GEÇMEZ: yalnız sayaç + zaman damgası.
  ipcMain.handle('pty:streamStat', (_event, paneId) => {
    const entry = ptys.get(paneId);
    if (!entry) return { ok: false };
    return { ok: true, bytes: entry.bytes, lastDataAt: entry.lastDataAt ?? null };
  });

  ipcMain.handle('pty:attach', (_event, paneId) => {
    const entry = ptys.get(paneId);
    if (!entry) return { ok: false };
    logLine(`pty:attach paneId=${paneId} seq=${entry.bytes} bufLen=${entry.buffer.length}`);
    return {
      ok: true,
      buffer: entry.buffer,
      seq: entry.bytes,
      agentId: entry.agentId ?? null,
      department: entry.department ?? null,
      command: entry.command,
      label: entry.label ?? null,
      cwd: entry.cwd ?? null, // ADP-108 — for cwd-aware live-watch path rebasing.
      // ADP-694 — canlı bir KURULUM REHBERİ pane'ine bağlanıyor olabiliriz (renderer
      // reload / pop-out). Kaplama bu iki alandan geri kurulur; yoksa kullanıcı yine
      // "sessiz" bir pane görürdü. null = normal pane.
      engineMissing: entry.engineMissing ?? null,
      engineInstall: entry.engineInstallGuide ?? null,
      // ADP-852 — aynı gerekçe: çalışma alanı rehberi kaplaması da attach'ta geri kurulur.
      workspaceMissing: entry.workspaceMissing === true,
      defaultWorkspaceDir: entry.workspaceMissing === true ? workspaceOnboarding.defaultWorkspaceDir() : null,
      // WIN-FIRSTRUN-01 (K1) — kabuk rehberi kaplaması da attach'ta geri kurulur.
      shellMissing: entry.shellMissing ?? null,
      // ENG-10 — pop-out / renderer reload sonrası yetenek rozetleri de geri kurulur
      // (aynı gerekçe: `engineMissing` kaplaması gibi, kaybolursa pane "sessizce tam
      // yetenekli" görünür).
      capabilities: entry.capabilities ?? null,
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADP-692 — KORUMALI YAZIM: kullanıcının composer'ına ASLA dokunmayan tek yazım yolu.
  // ─────────────────────────────────────────────────────────────────────────
  // Bir pane'e "kendiliğinden" metin yazan HER yol (supervisor uyandırması + ADP-667
  // kill-switch'inin renderer nudge'ı) buradan geçmek zorundadır. Neden main:
  // kapı ile yazım AYNI SENKRON BLOKTA olmalı — renderer'da "kontrol et, sonra yaz"
  // iki ayrı IPC'dir ve aralarında `pty:input` işlenebilir (Eren'in yarım-prompt
  // şikâyetinin ta kendisi). Burada araya hiçbir şey giremez (tek iş parçacığı).
  //
  // ENTER da AYNI blokta gider: metin ile '\r' arasına gecikme koymak (eski renderer
  // yolu 400ms bekliyordu) tam o pencerede yazmaya başlayan kullanıcının metnini
  // gönderir. Kapı kapalıysa HİÇBİR ŞEY yazılmaz (yarım yazım da yok).
  ipcMain.handle('pty:writeGuarded', (_event, payload) => {
    const paneId = payload && payload.paneId;
    const entry = paneId ? ptys.get(paneId) : null;
    if (!entry) return { ok: false, reason: 'no-pane' };
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    if (!text) return { ok: false, reason: 'empty' };
    // GERÇEK CAS: çağıran "ben bu buffer'ı gördüm" der; main o günden bugüne bir şey
    // değiştiyse (kullanıcı yazmaya başladı, TUI yeniden çizdi) yazımı reddeder.
    // `seenBuffer` verilmezse stabilite kontrolü VAKUM olurdu → o zaman yalnız insan
    // varlığı + composer hükmü korur; çağıranların geçmesi beklenir.
    /* TOK-C — BÜTÇE FRENİ. Bütçesi dolmuş pane'e otomatik iş YAZILMAZ.
       🔴 İki sınır bilinçli:
         • KULLANICININ kendi yazdığı (`pty:input`, origin=human) engellenmez —
           fren SİSTEMİN harcamasına, insanın klavyesine değil. "Duraklat"
           burada "ajanı öldür" demek değildir; pane yaşar, oturum durur.
         • Ölçülemeyen pane ENGELLENMEZ (paneBudget kural 2) — tahminle iş
           durdurmuyoruz.
       D-02 v2 DÜZELTMESİ: bu kapı otomatik yazımın TEK yolu DEĞİLDİR (öyle
       sanılmıştı). Görev dağıtımı `pty:input`ten, otomatik devam ise resume
       daemon'ından geçiyor ve ikisi de frenin dışındaydı — üçü de artık
       `spendGuard` + `paneBudgetDecisionFor` ile AYNI kararı uygular. */
    const guarded = enforcePaneBudget({ paneId, entry, origin: spendGuard.SYSTEM_ORIGIN, source: 'writeGuarded' });
    if (!guarded.allow) return { ok: false, reason: 'budget-paused', budget: guarded.decision };
    const buf = entry.buffer || '';
    const seen = payload && typeof payload.seenBuffer === 'string' ? payload.seenBuffer : buf;
    const gate = leaderComposer.injectionGate(seen, buf, {
      lastInputAt: typeof entry.lastInputAt === 'number' ? entry.lastInputAt : null,
      lastSubmitAt: typeof entry.lastSubmitAt === 'number' ? entry.lastSubmitAt : null,
      now: Date.now(),
    });
    if (!gate.safe) {
      logLine(`pty:writeGuarded REDDEDİLDİ paneId=${paneId} sebep=${gate.reason}`);
      return { ok: false, reason: gate.reason };
    }
    try {
      entry.child.write(text);
      if (payload && payload.submit !== false) entry.child.write('\r');
    } catch (err) {
      logLine(`pty:writeGuarded yazılamadı paneId=${paneId}: ${err.message}`);
      return { ok: false, reason: 'write-failed' };
    }
    return { ok: true, reason: 'ok' };
  });

  // ADP-896 — pane defterde yok: oturum hakkında hüküm veremeyiz ('no-pane'), bu
  // 'session-not-started'tan AYRI tutulur (o, mint edilmiş sessionId'nin dosyasının
  // yokluğudur = pozitif başlamama kanıtı).
  // ADP-705 — BAYAT id ile okuma YASAK: `/clear` sonrası oturum çözülene kadar
  // sessionId null'dır ve prob `checked:false` ("bakılamadı") döner. Eski davranış
  // eski dosyayı okuyup "prompt yok" diyor ve çalışan worker'ı öldürüyordu.
  // ENG-02 — motor dalı `probeTranscriptContains` içinde (codex = rollout defteri).
  ipcMain.handle('pty:transcriptContains', (_event, paneId, needle) =>
    probeTranscriptContains(paneId, needle));

  // ADP-306 — "X ajanının son mesajını oku": pane claude ise transcript'teki SON
  // asistan mesajı (EN GÜVENİLİR kaynak — TUI render'ı değil, modelin metni).
  // checked=false → transcript yok/pane claude değil: renderer buffer-parse'a düşer
  // (lastReply.ts motor adaptörleri). Yalnız OKUR; renderer path GEÇEMEZ.
  ipcMain.handle('pty:lastTranscriptMessage', (_event, paneId) => {
    const entry = ptys.get(paneId);
    if (!entry) return { checked: false, text: null, file: null, engine: null };
    // ADP-705 — sıfırlama sonrası oturum çözülene kadar null → checked:false →
    // çağıran buffer-parse'a düşer (BAYAT konuşmanın son mesajını "güncel" diye sunmaz).
    const res = transcriptProbe.lastAssistantMessage({ cwd: entry.cwd, sessionId: currentSessionId(paneId) });
    // ADP-586 — transcript DOSYASI ham jetonu içerebilir (ajan `env` çıktısını
    // konuşmasına yazdıysa); okunan metin maskeden geçmeden renderer'a gitmez.
    return { ...secretRedactor.redactDeep(res), engine: entry.command ?? null };
  });

  // ADP-401 — masaüstü OKUMA MODU: pane'in claude oturum defterinden (JSONL)
  // yapılandırılmış sohbet SAYFASI — mobil GET /m/panes/:id/transcript ile AYNI
  // çekirdek (mobileTranscript.readTranscriptPage; sayfalama `before` bayt imleci).
  // supported:false → çağıran ham VT görünümüne düşer (codex/shell). Pane bilgisi
  // main'in pty defterinden çözülür — renderer path GEÇEMEZ; yalnız OKUR.
  ipcMain.handle('pty:transcriptPage', (_event, paneId, opts) => {
    const entry = ptys.get(paneId);
    if (!entry) return null;
    const o = opts && typeof opts === 'object' ? opts : {};
    // ADP-586 — sayfadaki mesaj metinleri maskeden geçer (bkz. lastTranscriptMessage).
    return secretRedactor.redactDeep(mobileTranscript.readTranscriptPage({
      cwd: entry.cwd,
      // ADP-705 — `/clear` sonrası GÜNCEL oturum (bayat id ile eski konuşma gösterilmez).
      sessionId: currentSessionId(paneId),
      // CDX-READ-02 — claude-dışı defter (codex rollout) eşlemesi açılış damgası ister;
      // engine yalnız shell'i dışlamak için gider (çözüm notu mobileTranscript.cjs'te).
      startedAt: entry.startedAt ?? null,
      engine: entry.command ?? null,
      limit: o.limit,
      before: o.before,
    }));
  });

  // ADP-887 — PANE'İN JETON/MALİYET KÜNYESİ (başlıktaki 'i' kartı).
  //
  // Eren: "hangi terminal, hangi execution ne kadar maliyete sahip, ne kadar token
  // tüketiyor totalde." Ölçüm motorun KENDİ defterinden gelir (claude transcript'i /
  // codex rollout'u) — TUI buffer'ı tahmini değil, faturalanan sayının ta kendisi.
  //
  // Pane→{cwd,sessionId,motor} çözümü main'in pty defterinden yapılır; renderer
  // yalnız paneId geçer (transcriptContains/transcriptPage ile AYNI kapalı devre:
  // renderer path GEÇEMEZ, fs erişimi burada kalır).
  //
  // 🔴 usd null dönebilir ve bu bir HATA DEĞİLDİR: abonelik motoru, fiyatsız motor
  // veya ölçülemeyen defter → renderer sayı yerine gerekçeyi yazar (sahte 0$ yasak).
  ipcMain.handle('pty:tokenUsage', (_event, paneId) => {
    const id = String(paneId || '');
    const entry = ptys.get(id);
    if (!entry) return null;
    const usage = tokenUsage.usageForPane({
      paneId: id,
      engine: entry.command ?? null,
      cwd: entry.cwd ?? null,
      // ADP-705 — `/clear` sonrası GÜNCEL oturum (bayat id bambaşka bir konuşmanın
      // jetonlarını "bu oturum" diye gösterirdi).
      sessionId: currentSessionId(id),
      startedAt: entry.startedAt ?? null,
    });
    /* TOK-C — BÜTÇE KARARI AYNI ÖLÇÜMDEN türetilir ve aynı yanıtta gider.
       İkinci bir IPC/hesap yolu açmıyoruz: kart neyi gösteriyorsa kapı da onu
       uyguluyor. Ayrı yol olsaydı "kartta $5.20 yazıyor ama duraklatmadı"
       (ya da tersi) sınıfından sessiz sapma kaçınılmaz olurdu. */
    /* TOK-B — DAĞITIM KARARI da AYNI ölçümden gider (kart "sonraki iş taze
       oturumda başlar" diyebilsin diye). Burada iş METNİ yoktur → ilişki hükmü
       ölçülmez; kart yalnız DURUMA bakan kararı gösterir (bağlam/boşta/istek). */
    /* LDR-F1 — LİDER TETİĞİ AYNI TURA BİNER. Yeni bir zamanlayıcı/ölçüm yolu
       AÇILMADI (D-02 dersi: iki yüzey iki ana bakmasın): rozet zaten 90 sn'de bir
       burayı çağırıyor ve dönen nesnede karar ZATEN vardı — LDR-R1 B2'nin bulduğu
       şey tam olarak buydu, karar üretiliyor ama TÜKETİLMİYORDU.
       `leaderRefreshTick` fire-and-forget'tır: ölçüm yolunu asla bekletmez ve
       `auto` dışındaki her kipte tek bayt yazmadan döner. */
    const dispatch = paneDispatchDecisionFor(id, entry);
    try {
      leaderRefreshTick(id, entry, dispatch);
    } catch (err) {
      logLine(`lider-tazeleme tetiği patladı paneId=${id}: ${err.message}`);
    }
    return {
      ...usage,
      // TOKEN-BUDGET-01 — HER İSTEKTE ödenen sabit yük. Ölçüm değil KALİBRE TAHMİN
      // (gerçek ölçüm bir model çağrısı ister: `npm run token:budget`); kart bunu
      // "~" ile gösterir. Motor koşmayan pane'de null → kart satırı çizmez.
      fixedLoad: paneFixedLoadView(entry),
      budget: paneBudgetStore.decide(id, usage),
      dispatch,
      // B2/B5'in kapanışı: kararın kendi ölçüsü (bağlam/eşik oranı) ekrana ÇIKAR.
      leaderRefresh: leaderRefreshViewFor(id, entry, dispatch),
    };
  });

  /* ─────────────────────────────────────────────────────────────────────────
     TOK-B (D-03) — DAĞITIM PLANI / TAZELEME / KAYIT
     Renderer'ın dağıtım yolları (delegasyon + board görevi) bu üç ucu kullanır:
       plan   → "bu pane'e bu işi yazayım mı, yoksa taze oturum mu?"
       refresh→ devir özeti + `/clear` (karar 'refresh' geldiyse)
       record → iş GERÇEKTEN yazıldı; bir sonraki kararın kıyas tabanı bu metin
     ───────────────────────────────────────────────────────────────────────── */
  ipcMain.handle('pty:dispatchPlan', (_event, payload) => {
    const paneId = payload && typeof payload.paneId === 'string' ? payload.paneId : '';
    const entry = ptys.get(paneId);
    if (!entry) return null;
    const text = payload && typeof payload.text === 'string' ? payload.text : null;
    const decision = paneDispatchDecisionFor(paneId, entry, { text });
    if (decision) logDispatchDecision(paneId, decision, (payload && payload.source) || 'dispatch');
    return decision;
  });

  ipcMain.handle('pty:dispatchRefresh', async (_event, payload) => {
    const paneId = payload && typeof payload.paneId === 'string' ? payload.paneId : '';
    const entry = ptys.get(paneId);
    if (!entry) return { ok: false, reason: 'no-pane', handoff: null };
    // Kararı BURADA yeniden ölçüyoruz: renderer'ın gönderdiği bir bayrağa
    // güvenseydik "tazele" komutu ölçümden KOPUK bir emre dönerdi (paneBudget
    // `extend`in aynı gerekçesi).
    const text = payload && typeof payload.text === 'string' ? payload.text : null;
    const decision = paneDispatchDecisionFor(paneId, entry, { text });
    if (!decision || decision.action !== 'refresh') {
      return { ok: false, reason: decision ? `not-required:${decision.code}` : 'undecidable', handoff: null, decision };
    }
    const res = await refreshPaneSession(paneId, {
      handoff: decision.handoff,
      decision,
      source: (payload && payload.source) || 'dispatch',
    });
    return { ...res, decision };
  });

  /** İş pane'e YAZILDI → bir sonraki ilişki ölçümünün kıyas tabanı (fire-and-forget). */
  ipcMain.on('pty:dispatchRecord', (_event, payload) => {
    const paneId = payload && typeof payload.paneId === 'string' ? payload.paneId : '';
    if (!paneId || !ptys.has(paneId)) return;
    const text = payload && typeof payload.text === 'string' ? payload.text : '';
    dispatchStore.record(paneId, text);
  });

  /* DELEG-DELIVER-01 — HAZIR-KAPI KARARI GÖRÜNÜR OLSUN. Renderer'ın teslim yolu
     bugüne dek main log'a hiçbir şey yazmıyordu; teşhis yalnız "sonra" damgalarına
     (undelivered) bakabiliyordu. `verdict` GÜVENSİZ olduğunda (silent-cap/hard-stop:
     pane tek bayt basmadan yazdık) satır UYARI olarak işaretlenir. */
  ipcMain.on('pty:deliveryTrace', (_event, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const paneId = typeof p.paneId === 'string' ? p.paneId : '';
    if (!paneId) return;
    const verdict = typeof p.verdict === 'string' ? p.verdict : 'bilinmiyor';
    const risky = verdict === 'silent-cap' || verdict === 'hard-stop';
    logLine(
      `hazır-kapı paneId=${paneId} karar=${verdict} bekleme=${Number(p.waitedMs) || 0}ms ` +
        `bufLen=${Number(p.tailLen) || 0} baytGördü=${p.sawBytes === true} engel=${Number(p.blockers) || 0}` +
        (risky ? ' — ⚠️ pane hazır SİNYALİ VERMEDEN yazıldı, teslim düşebilir' : ''),
    );
  });

  /* ─────────────────────────────────────────────────────────────────────────
     TOK-C — BÜTÇE AYARI + "DEVAM ET"
     ───────────────────────────────────────────────────────────────────────── */
  ipcMain.handle('pty:budget', (_event, payload) => {
    const action = payload && typeof payload.action === 'string' ? payload.action : 'get';
    const paneId = payload && typeof payload.paneId === 'string' && payload.paneId ? payload.paneId : null;
    if (action === 'set') {
      const res = paneBudgetStore.setBudget(paneId, (payload && payload.budget) || {});
      // Yazamadıysak SESSİZ KALMAYIZ (ADR-W10 Kural 2 dilinde): ayar bellekte
      // yaşar ama kullanıcı "kalıcı olmadı"yı log'da görebilmeli.
      if (!res.persisted) logLine(`pty:budget yazılamadı paneId=${paneId ?? 'default'}: ${res.error}`);
      logLine(`pty:budget set paneId=${paneId ?? 'default'} usd=${res.budget.usd} tokens=${res.budget.tokens} kalıcı=${res.persisted}`);
      return res;
    }
    if (action === 'resume') {
      /* Ölçümü BURADA alıyoruz: ödenek "harcanan + bir limit" tavanını kurar
         (paneBudget.extend). Renderer'ın gönderdiği bir sayıya güvenseydik fren
         istemciden gevşetilebilirdi. */
      const entry = paneId ? ptys.get(paneId) : null;
      const usage = entry
        ? tokenUsage.usageForPane({
            paneId,
            engine: entry.command ?? null,
            cwd: entry.cwd ?? null,
            sessionId: currentSessionId(paneId),
            startedAt: entry.startedAt ?? null,
          })
        : null;
      const res = paneBudgetStore.resume(paneId, Date.now(), usage);
      // 🔴 Duraklatma da devam da GÖRÜNÜR: ikisi de log'a düşer, kaç kez devam
      // edildiği karta yazılır. "Sessiz öldürme yok" kuralının diğer yarısı
      // "sessiz devam yok"tur.
      if (res.ok) logLine(`pty:budget devam paneId=${paneId} kez=${res.grant.count}`);
      /* TOK-C (D-02 v2) — DEVAM DA OLAY YAYAR. Aksi hâlde ofisteki "bütçe doldu"
         balonu, fren AÇILDIKTAN sonra bir sonraki ölçüm turuna (90 sn'ye) kadar
         ekranda kalırdı: duraklatmayı geç göstermek kadar geç KALDIRMAK da
         yalandır (kullanıcı "devam"a bastı, ofis hâlâ durdu diyor). */
      const appWin = getAppWindow();
      if (res.ok && appWin && !appWin.isDestroyed()) {
        appWin.webContents.send('pty:budget-event', {
          kind: 'resumed',
          source: 'pty:budget',
          paneId,
          agentId: (entry && entry.agentId) || null,
          budget: paneBudgetStore.decide(paneId, usage),
        });
      }
      return res;
    }
    return { ok: true, budget: paneBudgetStore.budgetFor(paneId) };
  });

  // ADP-013 — list live panes (optionally by department) for restore/reconcile
  // and for ADP-012's team→pane-set grid. Scoped to the caller's window.
  ipcMain.handle('pty:list', (event, department) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const dept = typeof department === 'string' && department ? department : null;
    // ADP-712 — POP-OUT PENCERESİ HİÇBİR pty'nin SAHİBİ DEĞİLDİR (ADP-593 kuralı).
    // Sahip-pencereye göre filtreleyen bu liste ona BOŞ dönüyordu; sonucu sessizdi
    // ama gerçekti: ayrı pencerede model/branch rozeti çizilemiyor, okunabilir mod
    // pane'in motorunu (shell mi ajan mı) ve VT genişliğini çözemiyordu. Pop-out
    // yalnız KENDİ pane'ini görür — kapsam genişlemesi yok.
    const popPaneId = popoutPaneIdForWindow(win);
    if (popPaneId) return listPanes(null, dept).filter((p) => p.paneId === popPaneId);
    return listPanes(win, dept);
  });

  // ORPHAN-ELECTRON-01 — SÜPERVİZÖRÜN YETİM BİÇMESİ. Motor (renderer) süreç
  // göremez; kural `electron/orphanElectron.cjs`te TEK yerde yaşar, burada yalnız
  // çağrılır (liderin elle koştuğu `scripts/orphanElectron.cjs` ile AYNI çekirdek).
  //
  //   { op: 'baseline' }                       → şu anki yetim pid'leri (dispatch anı)
  //   { op: 'reap', excludePids, olderThanMs } → BU alt-görev sırasında BELİREN yetimleri kapat
  //
  // ATIF TAHMİNLE DEĞİL FARKLA (TREE-ORPHAN-01 §4 deseni): dispatch anındaki yetim
  // kümesi taban alınır; yalnız SONRADAN beliren ve OTOMASYON işareti taşıyan
  // (CREWPANE_E2E=1) ağaçlar kapatılır. İnsanın açık instance'ı ve kurulu ofis
  // çekirdek tarafından zaten kapsam dışıdır.
  ipcMain.handle('pty:reapOrphanElectrons', async (_event, payload) => {
    const orphan = require('../../core/orphanElectron.cjs');
    try {
      // PERF-FLEET-01 — kapsam Electron'dan FİLOYA genişledi: panic gecesinin en
      // ağır kalemi (1 Playwright tarayıcısı + 11 yardımcı = 37,81 GB) hiçbir
      // biçicinin kapsamında değildi. Kural yine TEK yerde (orphanElectron.cjs).
      const rows = orphan.listOrphanFleet();
      if (!payload || payload.op === 'baseline') {
        return { ok: true, pids: rows.map((r) => r.pid), scanned: rows.length };
      }
      const exclude = new Set((payload.excludePids || []).map(Number));
      const fresh = rows.filter((r) => !exclude.has(r.pid) && r.automated && !r.protectedBy);
      if (!fresh.length) return { ok: true, reaped: [], scanned: rows.length };
      const res = await orphan.reapOrphanFleet({
        rows: fresh,
        olderThanMs: Number(payload.olderThanMs ?? 0), // sahibi ölmüş → beklemenin anlamı yok
      });
      logLine(`orphan-fleet reap=${res.reaped.length}/${rows.length} pids=${res.reaped.map((r) => r.pid).join(',') || '-'}`);
      return { ok: true, ...res };
    } catch (e) {
      // Temizlik bir HÜKÜM DEĞİLDİR: ölçemedik/atadı → sessizce boş dön, delegasyon akışı sürsün.
      return { ok: false, reason: String((e && e.message) || e), reaped: [] };
    }
  });

  // ADP-013 — (re)bind a live pane to an agent/department/label after spawn
  // (e.g. the renderer assigns a slot post-hoc). Only updates fields that are
  // provided; unknown paneId is a no-op.
  ipcMain.on('pty:bind', (_event, payload) => {
    const entry = payload && ptys.get(payload.paneId);
    if (!entry) return;
    if (typeof payload.agentId === 'string' || payload.agentId === null) entry.agentId = payload.agentId;
    if (typeof payload.department === 'string' || payload.department === null) entry.department = payload.department;
    if (typeof payload.label === 'string' || payload.label === null) entry.label = payload.label;
    // ADP-558 — the invisible half-work flag rides on the pane entry (the old
    // user-facing STALLED label was removed; this flag carries the state instead).
    if (typeof payload.stalled === 'boolean') entry.stalled = payload.stalled;
    // ADP-502 — a STALLED pane's evidence target rides on the pane entry (same
    // lifecycle as the stall flag): the renderer's stall ledger is RAM-only, so
    // after a renderer-only reset (crash-watchdog reload, DevTools reload) main
    // still remembers the stall but nobody remembers the evidence path → the stall
    // could never be retracted. listPanes exposes it back, and the fresh renderer
    // re-seeds its ledger from it (paneRecycler.hydrateStalledFromPanes).
    if (typeof payload.stallEvidence === 'string' || payload.stallEvidence === null) entry.stallEvidence = payload.stallEvidence;
    // ADP-667 — gecikmeli reset bayrağı (recycler true yazar, flush false yazar).
    if (typeof payload.pendingReset === 'boolean') entry.pendingReset = payload.pendingReset;
    // ADP-565 — a claude pane switched IN-SESSION to a new model (delegation reuse
    // mismatch → `/model <alias>`). Keep the AUTHORITATIVE launchModel + the badge in
    // sync so a later reuse sees the CURRENT model (no redundant re-switch) and the
    // header chip shows it immediately (the K2 sniffer also confirms from the output).
    if (typeof payload.launchModel === 'string' || payload.launchModel === null) {
      const m = payload.launchModel ? agentRunner.sanitizeModel(payload.launchModel) : null;
      entry.launchModel = m;
      // AGENT-MODEL-01 — oturum-içi /model modeli değiştirir, EFORU DEĞİŞTİRMEZ
      // (`--effort` launch bayrağı). Sonek korunur, yoksa rozet yanlış söylerdi.
      const lbl = m ? modelDetect.withEffortSuffix(modelDetect.labelForModelId(m), entry.launchEffort) : null;
      if (lbl) entry.modelLabel = lbl;
      logLine(`pty:bind model-switch paneId=${payload.paneId} model=${m ?? '-'} label=${lbl ?? '-'}`);
    }
    logLine(`pty:bind paneId=${payload.paneId} agentId=${entry.agentId ?? '-'} dept=${entry.department ?? '-'} label=${entry.label ?? '-'}`);
  });

  // ADP-303 — a write to a pty whose child just died throws (EIO/EPIPE) straight out of the
  // IPC handler → uncaughtException → crash dialog. A dead pane must be a silent no-op.
  ipcMain.on('pty:input', (_event, payload) => {
    const entry = payload && ptys.get(payload.paneId);
    if (!entry) return;
    /* TOK-C (D-02 v2) — BÜTÇE FRENİ BU KANALDA DA GEÇERLİ.
       Bu kanal iki AYRI şeyi taşır ve bugüne dek ikisi de aynı muameleyi
       görüyordu: (a) kullanıcının tuşları, (b) sistemin bir ajana YAZDIĞI görev
       promptu (taskAssignment → sendCommand → api.write). (b) frenin dışında
       kaldığı sürece "bütçe doldu, duraklattım" bir iddiadan ibaretti: kart
       duraklatıldı yazarken board'dan atanan yeni görev pane'e düşmeye devam
       ediyordu.
       🔴 Ayrım KİMLİKTEN değil çağrının BEYAN ETTİĞİ KAYNAKTAN çıkar
       (`origin:'system'`); beyan yoksa yazım İNSAN sayılır ve GEÇER — yanlış
       tarafa düşmenin bedeli kullanıcının tuşunun yutulmasıdır. */
    if (payload.origin === spendGuard.SYSTEM_ORIGIN) {
      const guard = enforcePaneBudget({
        paneId: payload.paneId,
        entry,
        origin: payload.origin,
        source: 'pty:input(system)',
      });
      if (!guard.allow) return; // sessiz DEĞİL: log + `pty:budget-event` yukarıda gitti
    }
    // ADP-667 — TUŞ DAMGASI: idle-guard'ın üçüncü sinyali. Buffer sinyali tek başına
    // yetmiyor — bir tuş basımı ile onun ekrana echo'su arasında pencere var ve o
    // pencerede buffer "stabil + boş" görünüyor (Eren: "ben yazarken araya giriyor").
    // Bu kanal renderer'ın yazımlarıdır; LİDER pane'ine delegasyon/recycler ASLA
    // yazmaz (lider hiç subtask almaz) → lider pane'inde pty:input ≈ İNSAN tuşlaması.
    entry.lastInputAt = Date.now();
    // ADP-692 — GÖNDERİM DAMGASI. "Son ENTER'dan beri tuş basıldı mı?" sorusunun tek
    // kaynağı. `lastInputAt > lastSubmitAt` ⇒ kullanıcının UÇUŞTA BİR TASLAĞI var ve
    // supervisor o pane'e HİÇ yazmaz — bu hüküm taslağın EKRANA ÇİZİLMESİNİ beklemez,
    // yani ADP-667'nin "nöbetçi boş dedi, kullanıcı 100ms sonra yazmaya başladı"
    // mikro yarışını yapısal olarak kapatır (Eren'in P0 şikâyeti).
    if (typeof payload.data === 'string' && /[\r\n\x03\x15]/.test(payload.data)) entry.lastSubmitAt = Date.now();
    // ASK-CARD-01 — kullanıcı KLAVYEDEN cevapladıysa (Enter) kart 'terminal' yoluyla
    // kapanır; kart yalan söylemez, ikinci cevap yazılmaz.
    if (payload.origin !== spendGuard.SYSTEM_ORIGIN) paneAskRuntime.noteInput(payload.paneId, payload.data);
    // ADP-705 — KONUŞMA SIFIRLAMASININ TEK GEÇİŞ NOKTASI. paneRecycler'ın `/clear`|`/new`
    // yazımı da, insanın yapıştırdığı komut da buradan geçer. Sıfırlamadan sonra pane'in
    // oturum id'si BİLİNMEZ (claude yeni uuid üretir, bize söylemez) → çapa işaretlenir
    // ve ilk transcript okumasında yeniden çözülür. Davranış motorun ADINDAN değil
    // YAZILAN KOMUTTAN türer (motor-agnostik, isim-bazlı kontrol yok).
    if (paneSessionAnchor.resetCommandIn(payload.data)) sessionAnchor.markReset(payload.paneId);
    try {
      entry.child.write(payload.data);
    } catch (err) {
      logLine(`pty write skipped (dead pane) paneId=${payload.paneId}: ${err.message}`);
    }
  });

  ipcMain.on('pty:resize', (_event, payload) => {
    const entry = payload && ptys.get(payload.paneId);
    if (entry && payload.cols > 0 && payload.rows > 0) {
      try {
        // WIN-FIRSTRUN-01 (K3) — win32'de İLK DATA gelene kadar resize node-pty'ye
        // VERİLMEZ (orada kuyruğa girer ve süreç öldüyse ilk data'da bu try/catch'in
        // DIŞINDA patlar → PROD-48). Boyut `entry.pendingResize`de bekler, ilk chunk'ta
        // onData uygular. POSIX'te karar her zaman 'apply' (bugünkü yol bit-bit aynı).
        const r = ptyResizeGate.handleResize(entry, payload.cols, payload.rows, {
          platform: process.platform,
          apply: (cols, rows) => {
            entry.child.resize(cols, rows);
            // ADP-362 — MOBİL VT DE AYNI BOYUTA GELİR. Aksi hâlde masaüstü penceresi
            // genişledikçe pty büyür, VT 100'de kalır ve claude'un çizdiği satırlar mobil
            // defterde sarılıp bölünürdü. Tek gerçek pty'nin boyutudur.
            entry.screen?.resize(cols, rows);
          },
        });
        logLine(`pty resize${r.action === 'deferred' ? ' (deferred until first data)' : ''} paneId=${payload.paneId} cols=${payload.cols} rows=${payload.rows}`);
      } catch (err) {
        logLine(`pty resize skipped (dead pane) paneId=${payload.paneId}: ${err.message}`);
      }
    }
  });

  // TASK-MRDXOGZJDQLJG — quit-aware: a pty:kill racing the app teardown must NOT
  // erase the registry entry (that is what wiped live-panes.json on the 22:50
  // self-update). Decision + effects live in paneKill.cjs (unit-tested).
  ipcMain.on('pty:kill', (_event, paneId) => {
    killPaneExplicitAndCleanup(paneId);
  });
}

module.exports = { registerPtyIpc };
