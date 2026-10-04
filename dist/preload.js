"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// src/preload/bridges/platform.js
var require_platform = __commonJS({
  "src/preload/bridges/platform.js"() {
    "use strict";
    var { contextBridge } = require("electron");
    var platformStr = String(process.platform || "");
    contextBridge.exposeInMainWorld("crewpanePlatform", platformStr);
    var perfNum = (name, fallback) => {
      const raw = String(process.env[name] ?? "").trim();
      if (!raw) return fallback;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    var perfFlag = (name, fallback) => {
      const raw = String(process.env[name] ?? "").trim();
      if (!raw) return fallback;
      return raw !== "0" && raw.toLowerCase() !== "false";
    };
    var perfSettings = {
      termFlushHz: perfNum("CREWPANE_TERM_FLUSH_HZ", 30),
      termHiddenFlushHz: perfNum("CREWPANE_TERM_HIDDEN_FLUSH_HZ", 4),
      termWriteRecovery: perfFlag("CREWPANE_TERM_WRITE_RECOVERY", true),
      termBlankRecovery: perfFlag("CREWPANE_TERM_BLANK_RECOVERY", true)
    };
    contextBridge.exposeInMainWorld("crewpanePerf", perfSettings);
    var LOCALE_FLAG = "--crewpane-locale=";
    function decodeLocale(argv) {
      const hit = (argv || []).find((a) => typeof a === "string" && a.startsWith(LOCALE_FLAG));
      if (!hit) return null;
      const parts = hit.slice(LOCALE_FLAG.length).split(":");
      const locale = parts[0];
      const preference = parts[1];
      if (locale !== "tr" && locale !== "en") return null;
      return {
        locale,
        preference: preference === "tr" || preference === "en" || preference === "system" ? preference : "system"
      };
    }
    var localeState = decodeLocale(process.argv);
    if (localeState) {
      contextBridge.exposeInMainWorld("crewpaneLocale", localeState);
    }
  }
});

// src/preload/bridges/database.js
var require_database = __commonJS({
  "src/preload/bridges/database.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    var SUPABASE_DB_FLAG = "--crewpane-db=";
    function decodeSupabaseDbTarget(argv) {
      const hit = (argv || []).find((a) => typeof a === "string" && a.startsWith(SUPABASE_DB_FLAG));
      if (!hit) return null;
      try {
        const bin = atob(hit.slice(SUPABASE_DB_FLAG.length));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const t = JSON.parse(new TextDecoder("utf-8").decode(bytes));
        return t && t.url ? t : null;
      } catch {
        return null;
      }
    }
    var supabaseDbTarget = decodeSupabaseDbTarget(process.argv);
    if (supabaseDbTarget) {
      const dbBridgeObject = {
        url: supabaseDbTarget.url,
        anonKey: supabaseDbTarget.anonKey,
        // ADP-621 — hangi SCHEMA: bulut crewpane-id'de uygulama tabloları `app` altında
        // (`public` = üyelik/fatura), yerel + e2e stack'lerde `public`te. Bu alan kabloda
        // düşerse renderer bulutta yanlış schema'yı sorgular ve HER sorgu 404 döner.
        schema: supabaseDbTarget.schema || void 0,
        // ADP-622 — KİMLİK: 'crewpane-id' ise app DB, jetonu imzalayan projeyle AYNI
        // projedir (ADP-621 kararı) → istemci her isteğe kullanıcının access token'ını
        // takar ve `auth.uid()` app schema'sında çözülür. Alan yoksa/başka değerse
        // istemci bugünkü gibi ANON key ile kurulur (yerel 54321, e2e 55321).
        auth: supabaseDbTarget.auth === "crewpane-id" ? "crewpane-id" : void 0,
        // Jetonu main ÜRETİR (safeStorage'daki oturumdan, süresi dolmuşsa SESSİZ
        // yenileyerek). Renderer jetonu saklamaz — her ihtiyaçta buradan ister; bu
        // yüzden `auth` kanalı bir DEĞER değil bir FONKSİYONDUR (bayat jeton olmasın).
        getAccessToken: () => ipcRenderer.invoke("appdb:token"),
        isE2E: !!supabaseDbTarget.isE2E,
        // ADP-723 — kanal rozeti (DataSourceBadge): "hangi kopya + hangi veri kaynağı"
        // ekranda görünsün. Alan yoksa (eski shell) rozet sessizce gizlenir.
        channel: typeof supabaseDbTarget.channel === "string" ? supabaseDbTarget.channel : void 0,
        customerBuild: supabaseDbTarget.customerBuild === true ? true : void 0,
        // ENV-01 Faz 3 — KARIŞIM KARARI (yalnız `warn` seviyesinde gelir). Rozet bunu
        // ÜRETMEZ, okur. ⛔ BU BEYAZ LİSTE BİR KAPIDIR: main tarafında alanı eklemek
        // YETMEZ, buraya yazılmayan alan renderer'a HİÇ ULAŞMAZ ve rozet sessizce
        // görünmez kalır (ENV-02 Faz 3'te ölçüldü: main `env`i geçiriyordu, preload
        // düşürüyordu, `window.crewpaneDb.env` undefined'dı).
        // ⛔ `message` BİLEREK GEÇMİYOR: o metin ana sürecin TÜRKÇE log cümlesidir ve
        // arayüzde kullanılırsa İngilizce oturumda Türkçe bir uyarı çıkar. Rozet METNİ
        // sözlükten (`env.badge.mixed*`) üretir; kabloda yalnız MAKİNE JETONU gider.
        mixed: supabaseDbTarget.mixed && typeof supabaseDbTarget.mixed === "object" ? { reason: supabaseDbTarget.mixed.reason } : void 0,
        // ENV-02 — DÖRT KATMAN (profil · şema · app DB · kimlik · giriş · posta).
        // Alanlar TEK TEK kopyalanır (ham nesne geçirilmez): kabloya ileride bir sır
        // eklenirse rozet onu kendiliğinden ekrana taşımasın. Anon anahtar burada YOK.
        env: supabaseDbTarget.env && typeof supabaseDbTarget.env === "object" ? {
          profile: supabaseDbTarget.env.profile || void 0,
          scheme: supabaseDbTarget.env.scheme || void 0,
          dbUrl: supabaseDbTarget.env.dbUrl || void 0,
          dbSchema: supabaseDbTarget.env.dbSchema || void 0,
          authUrl: supabaseDbTarget.env.authUrl || void 0,
          loginUrl: supabaseDbTarget.env.loginUrl || void 0,
          mailUrl: supabaseDbTarget.env.mailUrl || void 0
        } : void 0
      };
      contextBridge.exposeInMainWorld("crewpaneDb", dbBridgeObject);
    }
    var doctorBridgeObj = {
      /** → { generatedAt, overall:'ok'|'warn'|'fail', checks:[{id,label,status,detail,…}] } */
      run: () => ipcRenderer.invoke("doctor:run"),
      /**
       * ADP-907 — yabancı kancanın yazılı olduğu AYAR DOSYASINI kullanıcının editöründe aç.
       * Yalnız AÇAR: uygulama o dosyaya ASLA yazmaz. Gönderilen yol main'de doktorun kendi
       * aday listesiyle doğrulanır (listede yoksa açılmaz) → rastgele dosya açtırılamaz.
       * → { ok:true, via:'editor'|'folder' } | { ok:false, reason }
       */
      openHookSettings: (filePath) => ipcRenderer.invoke("doctor:openHookSettings", filePath)
    };
    contextBridge.exposeInMainWorld("crewpaneDoctor", doctorBridgeObj);
    var authBridgeObj = {
      /** → { ok, signedIn, email, licenseStatus:'none'|'fresh'|'grace'|'expired'|'invalid', seat, products[], requireSeat }. */
      get: () => ipcRenderer.invoke("crewpane:get"),
      /** Sistem tarayıcısında PKCE girişini başlat → { ok, url }. */
      signIn: () => ipcRenderer.invoke("crewpane:signIn"),
      /**
       * Hesaptan çık (sunucuda revoke + yerel oturum & lisans jetonu silinir).
       *
       * ADP-863 — SEÇENEKLER ARTIK KABLODA TAŞINIR (eskiden hiç iletilmiyordu, bu yüzden
       * `force` yolu arayüzden ERİŞİLEMEZDİ → çalışan pane varken çıkış SESSİZCE reddedilirdi):
       *   `{ probe:true }` → çıkmadan "ne kapanacak" sayıları + onay metni
       *   `{ force:true }` → kullanıcı onay diyaloğunu onayladı, çalışan pane'lere rağmen çık
       */
      signOut: (opts) => ipcRenderer.invoke("crewpane:signOut", opts),
      /** Lisans jetonunu yeniden çek (ağ hatasında cached jeton KORUNUR — offline ≠ kilit). */
      refresh: () => ipcRenderer.invoke("crewpane:refresh"),
      /**
       * SEC-01 — hesaba bağlı cihazlar → { ok, devices:[…], currentDeviceId }.
       * `currentDeviceId` listede "bu cihaz"ı işaretlemek için: kullanıcı oturduğu
       * makineyi yanlışlıkla çıkarmasın.
       */
      devices: () => ipcRenderer.invoke("crewpane:devices"),
      /**
       * SEC-01 — cihazı hesaptan çıkar → { ok, device } | { ok:false, reason }.
       * Cihazdaki hiçbir veri silinmez; yalnız o kurulum yeni lisans jetonu alamaz.
       * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
       */
      revokeDevice: (deviceId) => ipcRenderer.invoke("crewpane:deviceRevoke", deviceId),
      /**
       * SEC-02 — DİĞER CİHAZLARI BIRAK → { ok, released } | { ok:false, reason }.
       * `revokeDevice`ten AYRI: koltuğu boşaltır, cihazı hesapta BIRAKIR. Uyuyan ya
       * da çöken bir makine kirasını bırakamadığında kullanıcının kaçış kapısıdır.
       * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
       */
      releaseOtherDevices: () => ipcRenderer.invoke("crewpane:deviceReleaseOthers"),
      /** ADP-646 — "Paket al": faturalandırma sayfasını SİSTEM TARAYICISINDA aç → { ok, url }. */
      openBilling: () => ipcRenderer.invoke("crewpane:openBilling"),
      /**
       * ADP-719 — giriş dönüşü (crewpane://) DOĞRU uygulamaya mı geliyor?
       * → { ok, severity:'blocking'|'warn'|null, ownsDefault, conflicts:[{path,bundleId,name}], reason }
       * `{ repair:true }` şema sahipliğini bu uygulamaya geri alır (kullanıcı tıkı).
       */
      schemeHealth: (opts) => ipcRenderer.invoke("crewpane:schemeHealth", opts),
      /**
       * LX-SAFESTORAGE-01 — bu makinede oturum SAKLANABİLİR Mİ?
       * → { ok, measured, available, backend, plaintext, canStore, reasonKey }
       * `canStore:false` ise giriş duvarı kullanıcıya SEBEBİNİ söyler (her açılışta
       * yeniden giriş isteneceğini). SIR TAŞIMAZ: yalnız arka ucun adı + hüküm.
       * `canStore:null` = ölçülemedi ("kapalı" DEĞİL — ADP-721).
       */
      secretBackend: () => ipcRenderer.invoke("crewpane:secretBackend"),
      /**
       * ADP-719 — İKİNCİ GİRİŞ YOLU: deep-link dönmediyse tarayıcının adres
       * çubuğundaki dönüş bağlantısı elle verilir; deep-link ile AYNI yoldan işlenir.
       */
      pasteCallback: (url) => ipcRenderer.invoke("crewpane:pasteCallback", url),
      /** Main durum değişince push eder (giriş/çıkış/jeton) → Ayarlar CANLI güncellenir. */
      onState: (cb) => {
        const l = (_e, s) => cb(s);
        ipcRenderer.on("crewpane:state", l);
        return () => ipcRenderer.removeListener("crewpane:state", l);
      },
      // ── RESET-03 — KURULUMU SIFIRLA ───────────────────────────────────────────
      //
      // 🔴 BEYAZ LİSTE KAPIDIR ([[ref_preload_whitelist_is_a_gate]]) — ve KAPININ
      // İKİ KATI VAR. İlk yazımda bu iki metot AYRI bir `window.resetApi` globaline
      // konmuştu: kanal adları doğruydu, main handler'ı vardı, kanal kapısı YEŞİLDİ
      // — ama RESET-02 köprüyü `window.crewpaneApi` ÜZERİNDE arıyor
      // (`resetFlow.resetApiFrom(crewpaneApi())`) ve bulamayınca "Gelişmiş" bölümünü
      // HİÇ ÇİZMİYOR. Yani özellik sessizce ölüyordu. Kanalın VAR olması yetmez;
      // KARŞI TARAFIN BAKTIĞI YERDE olması gerekir.
      //
      // KARAR BURADA VERİLMEZ. Onay sözcüğünü MAIN karşılaştırır (dil main'de
      // bilinir, renderer'a güvenilmez); bu köprü yalnız kullanıcının yazdığı metni
      // taşır. Yol/hedef alanları main'de DÜŞER (resetGate.sanitizeRequest).
      /**
       * KURU KOŞUM — hiçbir şey silinmez. `{ level }`
       * → { ok, level, bytesTotal:number|null, targets:[{kind,bytes,entries}],
       *     keeps:[{label}], warnings:[string], confirmWord, panes, terminals, agents }
       * `bytesTotal:null` = "hesaplanamadı" (0 DEĞİL).
       */
      resetPlan: (opts) => ipcRenderer.invoke("reset:plan", opts),
      /**
       * SIFIRLAMA İSTEĞİ — { level:'session'|'full', confirmText, keepLogs }.
       * → { ok:true, restarting:true } | { ok:false, reason:'bad_confirm'|'bad_level'|… }
       * Çalışan süreçte hiçbir kullanıcı dosyası silinmez: main işaretçi yazar ve
       * uygulama yeniden başlar; silme yeni sürecin EN BAŞINDA olur (Windows kilidi).
       */
      resetRequest: (req) => ipcRenderer.invoke("reset:request", req)
    };
    contextBridge.exposeInMainWorld("crewpaneApi", authBridgeObj);
  }
});

// src/preload/bridges/core.js
var require_core = __commonJS({
  "src/preload/bridges/core.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("demoSiteApi", {
      /** Örnek sitenin adresi. → { ok:true, url } | { ok:false } (dosya pakette yoksa). */
      url: (lang) => ipcRenderer.invoke("demo:siteUrl", { lang })
    });
    contextBridge.exposeInMainWorld("workerNotifyApi", {
      emit: (evt) => ipcRenderer.invoke("notify:workerEvent", evt)
    });
    contextBridge.exposeInMainWorld("windowApi", {
      /** Switch the tmux session's active window to the team that owns `department`. */
      selectForDepartment: (department) => ipcRenderer.invoke("tmux:selectWindow", department)
    });
    contextBridge.exposeInMainWorld("appApi", {
      /** → { mode:'dev'|'prod'|'spike', packaged, rebuildSupported }. */
      info: () => ipcRenderer.invoke("app:info"),
      /** One-click rebuild (electron:build:prep) + relaunch. → { ok, started } | { ok:false, reason }. */
      rebuildRelaunch: () => ipcRenderer.invoke("app:rebuildRelaunch"),
      /** ADP-232 — plain relaunch (NO rebuild) to apply restart-gated settings (workspaceRoot). → { ok }. */
      relaunch: () => ipcRenderer.invoke("app:relaunch"),
      /** Subscribe to rebuild progress. cb gets { phase:'start'|'log'|'done'|'error', line }. Returns unsubscribe. */
      onRebuildProgress: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("app:rebuild:progress", l);
        return () => ipcRenderer.removeListener("app:rebuild:progress", l);
      },
      /** ADP-284 — pencere görünürlüğü (minimize/hide → false). Canvas render kapıları için; returns unsubscribe. */
      onWindowVisible: (cb) => {
        const l = (_e, visible) => cb(!!visible);
        ipcRenderer.on("app:window-visible", l);
        return () => ipcRenderer.removeListener("app:window-visible", l);
      },
      /**
       * ADP-901 — RENDERER MODÜL HATASI → uygulama günlüğü + bildirim merkezi.
       * ADP-335 sınırı yalnız MAIN'deki modülleri kapsıyordu; ofis tuvali öldüğünde
       * (GL bağlam kaybı) uygulamanın gününde TEK BİR İZ kalmıyordu — teşhis, olayın
       * kendisinden değil ekran görüntüsünden başlamak zorunda kaldı. Artık renderer
       * de aynı deftere yazar. `{ label, message, location?, stopped? }`.
       */
      reportFault: (fault) => ipcRenderer.invoke("module:reportRenderer", fault),
      /**
       * OBS-01 — ÜRÜN ANALİTİĞİ: "hangi panel/sekme kullanılıyor".
       * Gövde `{ event:'panel_view', panel:'<dock sekme kimliği>' }` ile SINIRLI —
       * main tarafı olay adını ve panel kimliğini kapalı kümeye indirir, ortak damgayı
       * (sürüm/platform/katman) kendisi ekler. Serbest metin taşıyan bir alan YOK.
       */
      track: (payload) => ipcRenderer.invoke("analytics:track", payload),
      // HATA-06 — kurtarma merdiveninin KABUK basamakları (sayfa-içi yol yetmediğinde).
      // Renderer PARAMETRE GEÇİREMEZ: yalnız kapalı bir eylem adı gönderir; hangi
      // pencerenin yenileneceğine/yaratılacağına main karar verir (capability modeli).
      officeRecover: (action) => ipcRenderer.invoke("office:recover", { action })
    });
    contextBridge.exposeInMainWorld("onboardingApi", {
      /** → { ok, local: kayıt|null, portable: kayıt|null } */
      load: () => ipcRenderer.invoke("onboarding:load"),
      /** → { ok, local, portable, error } */
      save: (progress) => ipcRenderer.invoke("onboarding:save", progress),
      // TOUR-02-C — bağlamsal ipuçları AYNI köprüde, AYRI kayıt: "hangi ipucu
      // gösterildi" ile "hangi görev bitti" iki farklı şemadır ve tek dosyada
      // birleştirilseydi biri diğerinin bilinmeyen alanını düşürürdü.
      /** → { ok, local: kayıt|null, portable: kayıt|null } */
      loadTips: () => ipcRenderer.invoke("onboarding:tips:load"),
      /** → { ok, local, portable, error } */
      saveTips: (tips) => ipcRenderer.invoke("onboarding:tips:save", tips)
    });
    contextBridge.exposeInMainWorld("presetAdvisorApi", {
      recommend: (payload) => ipcRenderer.invoke("presets:recommend", payload)
    });
  }
});

// src/preload/bridges/terminal.js
var require_terminal = __commonJS({
  "src/preload/bridges/terminal.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("ptyApi", {
      /**
       * Ask main to spawn a pty. ADP-013: opts may carry an agent-aware shape
       * `{ cols, rows, command: 'shell'|'claude'|'codex', args, cwd, env, agentId,
       * department, label }`. With no `command` it stays the ADP-003 login shell.
       * A disallowed `command` REJECTS the promise (main-side RCE guard).
       * Resolves to `{ paneId, pid, command, shell, agentId, department }`.
       */
      spawn: (opts) => ipcRenderer.invoke("pty:spawn", opts),
      /**
       * ADP-028 — attach to an existing pane (instead of spawning). Resolves to
       * `{ ok, buffer, seq, agentId, department, command, label }` so the renderer
       * can replay recent output and dedupe live events. `{ ok:false }` if the pane
       * is gone (caller falls back to a fresh spawn).
       */
      attach: (paneId) => ipcRenderer.invoke("pty:attach", paneId),
      /**
       * TERM-BLANK-01 — pane'in AKIŞ DEFTERİ: `{ ok, bytes, lastDataAt }`.
       * Nöbetçi "pty üretti ama bu renderer hiç almadı" hükmünü buradan kurar
       * (renderer kendi ALMADIĞINI ölçemez). Salt-okunur; pane yoksa `{ ok:false }`.
       */
      streamStat: (paneId) => ipcRenderer.invoke("pty:streamStat", paneId),
      /**
       * ADP-280 — teslim-doğrulama: pane'in claude transcript'inde `needle` geçiyor mu?
       * → { found, checked, file }. checked=false = transcript henüz yok/bakılamadı
       * (yanlış 'undelivered' üretme). Pane→sessionId/cwd çözümü main'de.
       */
      transcriptContains: (paneId, needle) => ipcRenderer.invoke("pty:transcriptContains", paneId, needle),
      /**
       * ADP-306 — pane'in claude transcript'indeki SON asistan mesajı
       * → { checked, text, file, engine }. checked=false = transcript yok/bakılamadı
       * (motor claude değil ya da henüz yazmadı) → çağıran buffer-parse'a düşer.
       */
      lastTranscriptMessage: (paneId) => ipcRenderer.invoke("pty:lastTranscriptMessage", paneId),
      /**
       * ADP-401 — masaüstü OKUMA MODU sayfası: pane'in claude oturum defterinden
       * yapılandırılmış sohbet öğeleri (mobil transcript ile aynı çekirdek).
       * `opts = { limit?, before? }` (before = bayt imleci, geriye sayfalama).
       * → { supported, items, firstOff, hasMore, file } · null = pane yok.
       * supported:false → çağıran ham VT görünümüne düşer (codex/shell).
       */
      transcriptPage: (paneId, opts) => ipcRenderer.invoke("pty:transcriptPage", paneId, opts),
      /**
       * ADP-887 — pane'in JETON/MALİYET künyesi (başlıktaki 'i' kartı).
       * → { engine, engineLabel, billing, measured, session:{tokens,usd,models},
       *     total:{…}, priceSource, plan, match } · null = pane yok.
       * 🔴 `usd: null` HATA DEĞİLDİR (abonelik / fiyatsız motor / ölçülemedi) —
       * çağıran sayı yerine gerekçeyi yazar; 0$ basmak YASAK.
       */
      tokenUsage: (paneId) => ipcRenderer.invoke("pty:tokenUsage", paneId),
      // TOK-C — pane bütçesi: oku / kur / "devam et". Karar MAIN'de verilir; renderer
      // yalnız gösterir ve düğmeye basar (eşik hesabı renderer'da KOPYALANMAZ).
      budget: (payload) => ipcRenderer.invoke("pty:budget", payload),
      /* TOK-B (D-03) — DAĞITIM POLİTİKASI: yeni iş gelince "aynı pane'de sürdür" mü
         "taze oturum" mu. Karar MAIN'de, ÖLÇÜMLE verilir (bağlam/boşta/istek/ilişki);
         renderer yalnız uygular. Eşikler `modelPricing.contextEconomics.dispatch`. */
      /** Plan al: `{action:'continue'|'refresh'|'unmeasured', handoff, code, reasons…}` · null = pane yok. */
      dispatchPlan: (payload) => ipcRenderer.invoke("pty:dispatchPlan", payload),
      /** Kararı UYGULA: (varsa) tek istekle devir özeti + `/clear`. Kararı main yeniden ölçer. */
      dispatchRefresh: (payload) => ipcRenderer.invoke("pty:dispatchRefresh", payload),
      /** İş pane'e YAZILDI — bir sonraki ilişki ölçümünün kıyas tabanı (fire-and-forget). */
      dispatchRecord: (paneId, text) => ipcRenderer.send("pty:dispatchRecord", { paneId, text }),
      /* DELEG-DELIVER-01 — HAZIR-KAPI KARARI MAIN LOG'A. Bu yolun (taze pane'e prompt
         yazımı) üretimde TEK BİR log satırı yoktu: `engineReadyRunner` `console.info`
         basıyor, o da main log'a düşmüyor ([renderer console] köprüsü yalnız AUTOTEST'te
         bağlanır) → 06.09'un 6 teslim düşüşünde yazımın NE ZAMAN ve pane HANGİ durumdayken
         yapıldığı görülemedi. Tek yön, ateşle-unut; hiçbir şey döndürmez. */
      /** `{paneId, verdict, waitedMs, tailLen, sawBytes, blockers}` → main log satırı. */
      deliveryTrace: (payload) => ipcRenderer.send("pty:deliveryTrace", payload),
      /* D-07 (SPRINT-TOK-01) — AŞAMA B: HAFIZA SEÇKİSİ GÖREV METNİYLE.
         Spawn'da seçki YAPILMAZ (görev metni o an yok — D-04'ün ölçtüğü kök neden);
         iş dağıtılmadan hemen önce burası çağrılır ve seçki İŞİN KENDİSİYLE yapılır.
         Eşiği geçen kayıt yoksa `text:''` döner → prompt'a hiçbir şey eklenmez. */
      /** → `{ ok, text, slugs, stats:{kept, considered, threshold, reason, chars} }` */
      memoryTaskBlock: (payload) => ipcRenderer.invoke("memory:taskBlock", payload),
      /**
       * ADP-013 — list live panes for this window, optionally filtered by
       * department (team→pane-set for ADP-012). Resolves to an array of
       * `{ paneId, agentId, department, command, label, pid, startedAt, status }`.
       */
      list: (department) => ipcRenderer.invoke("pty:list", department),
      /**
       * ORPHAN-ELECTRON-01 — YETİM Electron biçme (süpervizör yolu).
       * `{op:'baseline'}` → `{ok, pids, scanned}` (dispatch anındaki taban)
       * `{op:'reap', excludePids, olderThanMs}` → `{ok, reaped:[{pid, how, …}], scanned}`
       * Karar MAIN'de verilir (süreç ölçümü orada); renderer yalnız sorar.
       */
      reapOrphanElectrons: (payload) => ipcRenderer.invoke("pty:reapOrphanElectrons", payload),
      /** ADP-013 — (re)bind a live pane to an agent/department/label after spawn. */
      bind: (paneId, binding) => ipcRenderer.send("pty:bind", { paneId, ...binding || {} }),
      /**
       * Keyboard / paste input from xterm → pty (routed by paneId).
       *
       * TOK-C (D-02 v2) — `opts.origin:'system'` bu yazımın İNSAN TUŞU DEĞİL otomasyon
       * olduğunu beyan eder (görev dağıtımı: taskAssignment → sendCommand). Main o
       * beyanı görürse bütçe frenini uygular. Beyan YOKSA yazım insan sayılır ve
       * geçer — güvenli taraf budur (yanlış tarafa düşmenin bedeli, kullanıcının
       * tuşunun sessizce yutulmasıdır).
       */
      write: (paneId, data, opts) => ipcRenderer.send("pty:input", {
        paneId,
        data,
        origin: opts && opts.origin === "system" ? "system" : void 0
      }),
      /**
       * ADP-692 — KORUMALI yazım: "kendiliğinden" gönderilen her metin (lider uyandırması)
       * bu yoldan geçer. Kapı (insan yazıyor mu / composer boş mu) ile yazım main'de AYNI
       * senkron blokta koşar → kullanıcının yarım prompt'unun ardına ASLA eklenemez.
       * `seenBuffer` = çağıranın son gördüğü buffer (CAS); değiştiyse yazım reddedilir.
       */
      writeGuarded: (paneId, text, opts) => ipcRenderer.invoke("pty:writeGuarded", {
        paneId,
        text,
        seenBuffer: opts && typeof opts.seenBuffer === "string" ? opts.seenBuffer : void 0,
        submit: !(opts && opts.submit === false)
      }),
      /** xterm fit → pty resize (routed by paneId). */
      resize: (paneId, size) => ipcRenderer.send("pty:resize", { paneId, cols: size.cols, rows: size.rows }),
      /** Kill a single pty by paneId (terminal closed in the UI). */
      kill: (paneId) => ipcRenderer.send("pty:kill", paneId),
      /** Subscribe to pty output for ALL panes. cb gets { paneId, data }. Returns unsubscribe. */
      onData: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("pty:data", listener);
        return () => ipcRenderer.removeListener("pty:data", listener);
      },
      /** Subscribe to pty exit for ALL panes. cb gets { paneId, code }. Returns unsubscribe. */
      onExit: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("pty:exit", listener);
        return () => ipcRenderer.removeListener("pty:exit", listener);
      },
      /**
       * ADP-303 — main asked for a pane to be brought to the front (the leader's
       * `crewpane_pane focus` → bridge → main). cb gets { paneId }. Returns unsubscribe.
       */
      onFocusRequest: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("pane:focus", listener);
        return () => ipcRenderer.removeListener("pane:focus", listener);
      },
      /**
       * ADP-192 — restart-resume notice: fired once on launch after main re-spawns the
       * agents that were running before shutdown. cb gets { count, agents:[{ agentId,
       * department, paneId, engine, resumed }] }. Returns unsubscribe.
       */
      onPanesRestored: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("panes:restored", listener);
        return () => ipcRenderer.removeListener("panes:restored", listener);
      },
      /**
       * ADP-734 Kapı 2 — KURTARILABİLİR PANE TEKLİFİ. Açılışta bulunan bayat bir kayıt
       * ya da defterin sessizce boşalması: main pane AÇMAZ, bunu yollar. cb gets
       * { count, reason, source, agents:[{agentId, department, engine, sessionId}] }.
       * Kabul → `restoreRecoverablePanes()`. Returns unsubscribe.
       */
      onPanesRecoverable: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("panes:recoverable", listener);
        return () => ipcRenderer.removeListener("panes:recoverable", listener);
      },
      /** ADP-734 — teklifi uygula: bekleyen pane'leri gerçekten aç. */
      restoreRecoverablePanes: () => ipcRenderer.invoke("panes:restoreRecoverable"),
      /**
       * ADP-335 — MODÜL HATASI. main'deki bir modül (VT harvest, gateway, store…)
       * kod hatası verdi: uygulama YAŞIYOR, o özellik degrade. cb gets
       * { module, label, message, location:'electron/paneScreen.cjs:87', stopped, at }.
       * Bildirim merkezinde dürüst tek satır olarak görünür; tıklanınca log açılır.
       */
      onModuleFault: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("module:fault", listener);
        return () => ipcRenderer.removeListener("module:fault", listener);
      },
      /** Bildirime tıklanınca: hata log'unu aç (dosya:satır zaten bildirimde). */
      openFaultLog: () => ipcRenderer.invoke("module:openLog"),
      /** Açılışta kaçırılan hatalar (son 20). */
      moduleFaults: () => ipcRenderer.invoke("module:faults"),
      /**
       * ADP-428 — limit auto-resume yaşam döngüsü olayları (main pty daemon).
       * cb gets { kind: 'continue'|'respawn'|'select'|'fail', paneId, agentId, detail }.
       * 'fail' = daemon gönderim bütçesini tüketti → UI yapışkan uyarı göstermeli
       * (ajan İNSAN "devam et"i bekliyor). Returns unsubscribe.
       */
      onResumeEvent: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("resume:event", listener);
        return () => ipcRenderer.removeListener("resume:event", listener);
      },
      /**
       * TOK-C (D-02 v2) — BÜTÇE OLAYLARI (main → renderer).
       * cb gets { kind:'blocked', source, paneId, agentId, budget }.
       *
       * Neden olay, neden yalnız ölçüm turu değil: ölçüm turu 90 saniyede bir koşar;
       * duraklatmanın GERÇEKTEN olduğu an ise sistemin o pane'e yazmaya çalıştığı
       * andır. Ofis balonu o anda çıkmazsa kullanıcı, durmuş bir ajanın sprite'ında
       * bir buçuk dakika boyunca "çalışıyor" okur. Returns unsubscribe.
       */
      onBudgetEvent: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("pty:budget-event", listener);
        return () => ipcRenderer.removeListener("pty:budget-event", listener);
      }
    });
  }
});

// src/preload/bridges/agents.js
var require_agents = __commonJS({
  "src/preload/bridges/agents.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("agentxDraftApi", {
      /** → DraftSnapshot { state, text, units, target, revision, pending, notice, … } */
      get: () => ipcRenderer.invoke("agentxDraft:get"),
      /** RouteDecision (cls:'prompt') → taslağı aç / gövdeyi ekle. */
      open: (route, at) => ipcRenderer.invoke("agentxDraft:open", { route, at }),
      /** Sonlandırılmış cümle. `startedAt` = KAYDIN başladığı an (spokenAt kapısı buna bakar). */
      hear: (text, opts) => ipcRenderer.invoke("agentxDraft:hear", { text, ...opts || {} }),
      /** Klavye: metnin tamamı (ses ve klavye AYNI defter). */
      edit: (text) => ipcRenderer.invoke("agentxDraft:edit", { text }),
      setTarget: (target) => ipcRenderer.invoke("agentxDraft:setTarget", { target }),
      /** Sessizlik: taslak DURAKSAR — asla göndermez. */
      pause: (at) => ipcRenderer.invoke("agentxDraft:pause", { at }),
      noSpeech: (at) => ipcRenderer.invoke("agentxDraft:noSpeech", { at }),
      /** Gönder düğmesi / kapanış sözü → hedef sorusu ya da teyit. */
      finish: (at) => ipcRenderer.invoke("agentxDraft:finish", { at }),
      /** TTS özeti BİTTİ: bundan önce başlayan kayıt cevap sayılmaz. */
      spoken: (id, at) => ipcRenderer.invoke("agentxDraft:spoken", { id, at }),
      /** Düğme: 'send' | 'edit' | 'cancel'. */
      resolve: (id, choice, at) => ipcRenderer.invoke("agentxDraft:resolve", { id, choice, at }),
      cancel: (at) => ipcRenderer.invoke("agentxDraft:cancel", { at }),
      undo: (at) => ipcRenderer.invoke("agentxDraft:undo", { at }),
      tick: (at) => ipcRenderer.invoke("agentxDraft:tick", { at }),
      /** Fotoğraf değişti (her yüzey). cb: DraftSnapshot */
      onChanged: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("agentxDraft:changed", listener);
        return () => ipcRenderer.removeListener("agentxDraft:changed", listener);
      },
      /** "evet" dendi → draft:confirmed { id, revision, digest, target, text }. AXP-03 tüketir. */
      onConfirmed: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("agentxDraft:confirmed", listener);
        return () => ipcRenderer.removeListener("agentxDraft:confirmed", listener);
      }
    });
    contextBridge.exposeInMainWorld("engineApi", {
      /**
       * ADP-463-B — CLI kurulu mu → { engines:[{id,name,found,state,path,installUrl}], anyFound, anyUnknown }.
       * ADP-833 (ADR-W7): `state` üç-durumlu ('present'|'absent'|'unknown'); 'unknown' =
       * ölçemedik (UI onu "kurulu değil" diye GÖSTERMEZ).
       */
      check: () => ipcRenderer.invoke("engine:check"),
      /**
       * ENG-10 — motor YETENEK MATRİSİ: { ok, engines: { <id>: { engine, label, matrix } } }.
       * Ayarlar motor kartı ve entegrasyon hub'ı rozetlerini bundan çizer (pane açmadan).
       * Sır/dosya yolu DÖNMEZ — yalnız hüküm + motorun kendi beyan metni.
       */
      capabilityMatrix: () => ipcRenderer.invoke("engine:capabilityMatrix"),
      /**
       * ENG-19 — LİDER-UYGUNLUK + otomatik öneri:
       * { ok, engines:{<id>:{class:'full'|'fallback'|'never', auth, eligible, gaps, blockers, requirements}},
       *   order, recommended, recommendedClass, warning }
       * Hüküm descriptor'dan TÜRETİLİR (motor adına bakılmaz); giriş motorun KENDİ
       * durum komutundan okunur. Sır DÖNMEZ.
       */
      leadership: () => ipcRenderer.invoke("engine:leadership"),
      /**
       * ENG-21 — SUNULABİLİRLİK + DELEGASYON VATANDAŞLIĞI:
       * { ok, engines:{<id>:{offered, delegation:{class,capable,badge,blockers,warnings}}} }
       * `offered` = ENG-05 `engines.enabled` hükmünün ürünle gelen aynası (renderer
       * tabloyu okuyabilirse üstüne yazar). `delegation` = ENG-17 hükmü. Sır DÖNMEZ.
       */
      availability: () => ipcRenderer.invoke("engine:availability"),
      /** → { engines:[{engine,label,installed,loggedIn,method,account,plan,needsCode,error}] }. */
      authStatus: () => ipcRenderer.invoke("engineAuth:status"),
      /** Yönetilen giriş akışını başlatır (tarayıcıyı main açar) → { ok, session }. */
      login: (engine, profileId) => ipcRenderer.invoke("engineAuth:login", { engine, profileId }),
      /** Tarayıcı sayfasının verdiği kodu iletir (yalnız claude akışı) → { ok }. */
      submitCode: (code) => ipcRenderer.invoke("engineAuth:submitCode", { code }),
      /** Devam eden giriş akışını iptal eder → { ok }. */
      cancelLogin: () => ipcRenderer.invoke("engineAuth:cancel"),
      /** Oturumu kapatır; sonuç motorun kendi durum komutuyla DOĞRULANIR → { ok, status }. */
      logout: (engine, profileId) => ipcRenderer.invoke("engineAuth:logout", { engine, profileId }),
      // ── ENG-08 — API ANAHTARI YEDEĞİ (abonelik birinci sınıf, bu YEDEK yol) ────
      // Anahtar TEK YÖN akar: renderer → main → vault. Geri dönen yüzeyde sır YOKTUR
      // (yalnız `{ ok, error, status }`); `status.apiKeySaved` bir BAYRAKtır, değer değil.
      /** Motorun API anahtarını kaydeder ve motorun KENDİ komutuyla doğrular → { ok, error, status }. */
      setApiKey: (engine, key, profileId) => ipcRenderer.invoke("engineAuth:setApiKey", { engine, key, profileId }),
      /** Kayıtlı anahtarı siler → { ok, status }. */
      clearApiKey: (engine, profileId) => ipcRenderer.invoke("engineAuth:clearApiKey", { engine, profileId }),
      /** Akış ilerledikçe main'in ittiği anlık-görüntü. Dönen fn dinleyiciyi kaldırır. */
      onChanged: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("engineAuth:changed", handler);
        return () => ipcRenderer.removeListener("engineAuth:changed", handler);
      },
      // ── ADP-936 — HESAPLAR (çok-hesap geçişi) ──────────────────────────────────
      // Renderer YALNIZ profil KİMLİĞİ konuşur. Dizin yolu, Keychain yuvası ve jeton
      // bu köprüden HİÇ geçmez — çözüm main'de (electron/engineProfiles.cjs).
      /** → { ok, autoSwitchOnLimit, engines:[{engine,label,active,profiles:[…]}] }. */
      accounts: () => ipcRenderer.invoke("engineProfiles:list"),
      /** Yeni hesap kutusu açar → { ok, profileId }. Girişi çağıran `login` ile başlatır. */
      accountAdd: (engine, label) => ipcRenderer.invoke("engineProfiles:add", { engine, label }),
      /**
       * Aktif hesabı değiştirir → { ok, active, stalePanes }. Canlı pane'ler etkilenmez
       * (env başlangıçta okunur); ACCT-FIX-01 — `stalePanes` eski hesapla koşmaya devam
       * eden ajan pane'lerinin listesidir (paneId · agentId · label · profileId · limited).
       */
      accountSwitch: (engine, profileId) => ipcRenderer.invoke("engineProfiles:switch", { engine, profileId }),
      /**
       * ACCT-FIX-01 — seçilen pane'leri KAPATIP hedef hesapla, aynı oturumdan (`--resume`)
       * yeniden açar → { ok, results:[{paneId, ok, newPaneId, resumed}] }. Kullanıcı onayı
       * renderer'da alınır; bu köprü yol/dizin taşımaz, yalnız kimlikler.
       */
      accountRespawnPanes: (engine, profileId, paneIds) => ipcRenderer.invoke("engineProfiles:respawnPanes", { engine, profileId, paneIds }),
      /** Hesabın kullanıcı etiketini yazar → { ok }. */
      accountLabel: (engine, profileId, label) => ipcRenderer.invoke("engineProfiles:setLabel", { engine, profileId, label }),
      /** Hesabı kaldırır (önce o profilde çıkış, sonra defter+dizin) → { ok, active }. */
      accountRemove: (engine, profileId) => ipcRenderer.invoke("engineProfiles:remove", { engine, profileId }),
      /** "Limitte otomatik geç" tercihi → { ok, autoSwitchOnLimit }. */
      setAutoSwitch: (enabled) => ipcRenderer.invoke("engineProfiles:setAutoSwitch", { enabled }),
      // ── HATA-12 — AJANLARIN GÜNCEL MOTOR AYNASI ────────────────────────────────
      // Renderer `employees.engine`'i canlı okur; harita DEĞİŞTİĞİNDE main'e iter. Main
      // onu geri-yükleme defterinin yanına yazar ve bir sonraki açılışta pane'i ESKİ
      // motorla diriltmez (HATA-12'nin "yeniden başlatmak da kurtarmıyor" yarısı).
      /** `{agentId: motor}` → { ok, count }. Yalnız KAYITLI motorlar diske iner. */
      syncAgentEngines: (map) => ipcRenderer.invoke("agentEngines:sync", map),
      /** Hesap defteri değişince main iter (liste kendiliğinden tazelensin). */
      onAccountsChanged: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("engineProfiles:changed", handler);
        return () => ipcRenderer.removeListener("engineProfiles:changed", handler);
      }
    });
    contextBridge.exposeInMainWorld("delegationBridge", {
      /** Subscribe to delegate requests from main. cb gets { requestId, objective, leaderId, department, workers? }. */
      onStart: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("delegation:start", l);
        return () => ipcRenderer.removeListener("delegation:start", l);
      },
      /** Reply to a delegate request: { requestId, ok, delegationId?, error? }. */
      startResult: (res) => ipcRenderer.send("delegation:start:result", res),
      /** Subscribe to status requests from main. cb gets { requestId, id? }. */
      onStatus: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("delegation:status", l);
        return () => ipcRenderer.removeListener("delegation:status", l);
      },
      /** Reply to a status request: { requestId, ok, snapshot }. */
      statusResult: (res) => ipcRenderer.send("delegation:status:result", res),
      // ADP-242 — sprint kanalları (MCP crewpane_sprint → bridge → renderer orkestratörü).
      /** Subscribe to sprint-start requests. cb gets { requestId, objective, leaderId, department, tasks, maxConcurrent? }. */
      onSprintStart: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("sprint:start", l);
        return () => ipcRenderer.removeListener("sprint:start", l);
      },
      /** Reply: { requestId, ok, sprintId?, error? }. */
      sprintStartResult: (res) => ipcRenderer.send("sprint:start:result", res),
      /** Subscribe to sprint-status requests. cb gets { requestId, id? }. */
      onSprintStatus: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("sprint:status", l);
        return () => ipcRenderer.removeListener("sprint:status", l);
      },
      /** Reply: { requestId, ok, status }. */
      sprintStatusResult: (res) => ipcRenderer.send("sprint:status:result", res),
      // DF-03 — sprint durdurma kanalı (crewpane_sprint action:"stop").
      /** Subscribe to sprint-stop requests. cb gets { requestId, id?, reason? }. */
      onSprintStop: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("sprint:stop", l);
        return () => ipcRenderer.removeListener("sprint:stop", l);
      },
      /** Reply: { requestId, ok, sprintId?, summary?, wasLive?, error? }. */
      sprintStopResult: (res) => ipcRenderer.send("sprint:stop:result", res)
    });
    contextBridge.exposeInMainWorld("delegationQueueApi", {
      /** { queued:[], paused:[] } → { ok, file?, error? }. */
      save: (state) => ipcRenderer.invoke("dlgqueue:save", state),
      /** → { ok, state: { queued:[], paused:[] } }. */
      load: () => ipcRenderer.invoke("dlgqueue:load")
    });
    contextBridge.exposeInMainWorld("delegationSupervisorApi", {
      /** Dispatch anında: alt-görevi main defterine yaz (kanıt yolu + prompt imzası dahil). */
      record: (input) => ipcRenderer.invoke("dlgsup:record", input),
      /** Motor kendi settle etti → defteri hizala (supervisor çift notify/nudge yapmasın). */
      settle: (p) => ipcRenderer.invoke("dlgsup:settle", p),
      /** Lider durumu okudu → bekleyen uyandırmalar kapanır. */
      ack: (leaderId) => ipcRenderer.invoke("dlgsup:ack", leaderId),
      /** e2e/teşhis: defteri oku, tick'i elle sür. */
      debug: (action) => ipcRenderer.invoke("dlgsup:debug", action),
      /**
       * main → renderer: "şu alt-görev bitti (supervisor tespit etti), defterini hizala
       * ve kuyruğu ilerlet". Renderer İŞLEDİKTEN SONRA cevap verir; cevap gelmezse main
       * bir sonraki tick'te yeniden dener (iş asla sessizce düşmez).
       */
      onAdvance: (cb) => {
        const handler = (_e, msg) => {
          Promise.resolve().then(() => cb(msg)).then((ok) => ipcRenderer.send("dlgsup:advance:result", { requestId: msg && msg.requestId, ok: ok !== false })).catch(() => ipcRenderer.send("dlgsup:advance:result", { requestId: msg && msg.requestId, ok: false }));
        };
        ipcRenderer.on("dlgsup:advance", handler);
        return () => ipcRenderer.removeListener("dlgsup:advance", handler);
      }
    });
  }
});

// src/preload/bridges/skills.js
var require_skills = __commonJS({
  "src/preload/bridges/skills.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("skillsApi", {
      /**
       * → { ok, enabled, workspaceRoot, roots:{published,drafts}, engines:[{engine,dir}],
       *     counts:{published,draft,invalid},
       *     skills:[{ name, description, source:'user'|'ai', status, scope:'published'|'draft',
       *               path, file, ok, errors, warnings, origin, author, version, task,
       *               sourceMemory, reviewedBy, reviewedAt, license, updatedAt,
       *               engines:[{ engine, dir, state }] }] }
       * `state`: linked | copy | absent | dangling | conflict | exposed | disabled
       * (DEPO değil DİSK ölçülür: "yayında" ile "motor görüyor" ayrışabilir.)
       */
      list: () => ipcRenderer.invoke("skills:list"),
      /** Tek skillin tam kaydı + `body`/`text` (ham SKILL.md). Yoksa null. */
      read: (name, scope) => ipcRenderer.invoke("skills:read", name, scope),
      /**
       * SKL-B0 — MOTOR başına görünüm (SALT OKUNUR; hiçbir bağ kurmaz):
       * → { enabled, workspaceRoot, canonicalRoot, published:[ad],
       *     engines:[{ engine, dir, exists, sharedWith, linked:[ad], missing:[ad],
       *                conflicts:[{name,kind,blocking}], caveat:{state,reason}|null, ok }] }
       * `ok:true` → ENG-10 dilinde rozet ÜRETİLMEZ (tam çalışan motor sessizdir).
       */
      engineViews: () => ipcRenderer.invoke("skills:engineViews"),
      /**
       * SKL-B0 — [Şimdi eşitle]: reconcile'ı ELLE koştur. → { ok, reason, summary, report }
       * `summary` taze `engineViews` çıktısıdır (UI ikinci çağrı yapmaz).
       * Taslak YAYINLAMAZ — yalnız yayındakilerin motor bağlarını kurar/temizler.
       */
      syncEngines: () => ipcRenderer.invoke("skills:syncEngines"),
      /**
       * SK-04 — TASLAĞI YAYINA AL (insan onayı). Tek çağıran: onay kartındaki tıklama.
       * → { ok, name, dir, file, version, engines, errors, warnings }
       * `ok:false` + `errors[0].code`: `draft-missing` · `already-published` (→ `overwrite`
       * ile ikinci onay) · lint kodları (kırmızı taslak YAYINLANMAZ).
       * ONAYLAYAN damgasını main yazar — burada gönderilemez (kanıt uydurulamamalı).
       */
      publish: (name, opts) => ipcRenderer.invoke("skills:publish", name, opts),
      /**
       * SK-05 — TASLAK KAYDET ("Yeni Skill" formu + "Düzenle"). Girdi:
       * `{ name, description, body, mode:'create'|'update' }`.
       * → { ok, name, dir, file, scope:'draft', forkedFromPublished, errors, warnings }
       * `ok:false` + `errors[0].code`: `name-empty` · `name-invalid` (+`suggestion`) ·
       * `name-taken` (+`scope`) · `skill-missing` · `no-workspace` · lint kodları.
       * YAZAN damgasını main yazar. Yayına yazmaz: `mode:'update'` yayındaki bir skille
       * çağrılırsa taslağa ÇATALLANIR (`forkedFromPublished:true`) — canlı dosya durur.
       */
      saveDraft: (input) => ipcRenderer.invoke("skills:saveDraft", input),
      /**
       * SK-08 — YAYIN GEÇMİŞİ (salt okunur). → { name, versions:[{version, at, action,
       * reviewedBy, path, change:{added,removed,changed,first}, exists}], count }
       * En YENİ önce. `action`: 'publish' | 'rollback'.
       */
      history: (name) => ipcRenderer.invoke("skills:history", name),
      /**
       * SK-08 — GERİ ALMA: yayındaki skilli geçmiş bir sürümüne döndür (insan tıklaması).
       * → { ok, name, version, restoredFrom, engines, history, errors }
       * `ok:false` + code: `version-missing` · `restored-by-required` · lint · `secret-detected`.
       * 🔑 Onay kapısı DELİNMEZ: hedef metin geçmişte insan onayıyla yayınlanmış olandır;
       * geri alan kişinin damgasını main yazar (burada gönderilemez).
       */
      rollback: (name, version) => ipcRenderer.invoke("skills:rollback", name, version),
      /**
       * SK-08 — DIŞA AKTAR: paylaşılabilir SKILL.md metni. → { ok, name, text, errors }
       * Sır taramasından geçer: bulgu varsa metin VERİLMEZ (`blockedBy:'secret-scan'`).
       */
      export: (name, scope) => ipcRenderer.invoke("skills:export", name, scope),
      /**
       * SK-08 — İÇE AKTAR: `{ text }` ya da `{ filePath }` (+ `name`, `overwriteDraft`).
       * → { ok, name, scope:'draft', pendingApproval:true, errors }
       * 🔴 SONUÇ HER ZAMAN TASLAKTIR — bu ucun yayına giden bir yolu YOKTUR. Yabancı onay
       * damgaları ve "published" iddiası DÜŞÜRÜLÜR; provenans (`imported`) yazılır.
       */
      import: (payload) => ipcRenderer.invoke("skills:import", payload),
      /**
       * SK-08 — ONAY KAPISI DENETİMİ (T6). → { ok, checked, findings:[{kind,name,file,message}] }
       * `kind`: `unapproved-published` (damgasız yayın) · `invalid-published` ·
       * `draft-exposed` · `agent-written` · `dangling`. Merkez bunu uyarı şeridi yapar:
       * kapıyı atlatan bir yayın SESSİZ kalmasın.
       */
      audit: () => ipcRenderer.invoke("skills:audit"),
      /**
       * SKL-B6 — DAHİLİ KATALOG (paketle gelen skill'ler), SALT OKUNUR:
       * → { ok, dir, catalogVersion, counts:{total,installed,pending,forked},
       *     skills:[{ name, description, license, source, requires, riskNotes, sha256,
       *               state, installed, ours, modified, optedOut, file, installedSha,
       *               catalogSha, sourceCatalog, suggestion? }] }
       * `state`: absent · opted-out · installed · update-available · forked ·
       *          forked-update · conflict · tampered · orphan · missing-catalog
       */
      builtinList: () => ipcRenderer.invoke("skills:builtinList"),
      /**
       * SKL-B6 — DAHİLİ SKILL'İ KUR/GÜNCELLE. `opts`: `{ installAs, force }`.
       * → { ok, changed, action:'installed'|'updated'|'unchanged'|'none', name, file, errors }
       * `ok:false` + `errors[0].code`: `name-conflict` (+`suggestion`) · `user-modified`
       * (çatal — `force` ikinci onayı ister) · `builtin-tampered` · `secret-scan` ·
       * `not-in-catalog` · `no-workspace`.
       * 🔴 Sessiz üzerine yazma YOK: kullanıcının kendi skill'i ve DÜZENLEDİĞİ kopya
       * bu uçtan ezilemez. ONAYLAYAN damgasını main yazar (burada gönderilemez).
       */
      builtinInstall: (name, opts) => ipcRenderer.invoke("skills:builtinInstall", name, opts),
      /**
       * SKL-B6 — DAHİLİ SKILL'İ KALDIR: kurulu kopya + motor bağları gider ve tercih
       * KALICI olur (bir sonraki açılış geri kurmaz). Yalnız `origin: builtin` kopyayı
       * siler — kullanıcının kendi skill'ine dokunmaz (`not-ours`).
       * → { ok, changed, action:'removed'|'unchanged', name, errors }
       */
      builtinUninstall: (name) => ipcRenderer.invoke("skills:builtinUninstall", name)
    });
  }
});

// src/preload/bridges/tasks.js
var require_tasks = __commonJS({
  "src/preload/bridges/tasks.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("paneViewApi", {
      /** → { readable } (bilinmeyen pane için varsayılan). */
      get: (paneId) => ipcRenderer.invoke("paneView:get", paneId),
      /** Durumu yaz + yayınla. `patch = { readable }` → { ok, paneId, readable, changed }. */
      set: (paneId, patch) => ipcRenderer.invoke("paneView:set", { paneId, ...patch || {} }),
      /** Başka bir pencere durumu değiştirdi. cb gets { paneId, readable }. Returns unsubscribe. */
      onChanged: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("paneView:changed", listener);
        return () => ipcRenderer.removeListener("paneView:changed", listener);
      }
    });
    contextBridge.exposeInMainWorld("paneDraftApi", {
      /** → taslak metin (bilinmeyen pane için ''). */
      get: (paneId) => ipcRenderer.invoke("paneDraft:get", paneId),
      /** Taslağı yaz + (gerçekten değiştiyse) yayınla → { ok, paneId, text, changed }. */
      set: (paneId, text) => ipcRenderer.invoke("paneDraft:set", { paneId, text }),
      /** Aynı pane'i gösteren başka yüzey taslağı değiştirdi. cb: { paneId, text }. */
      onChanged: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("paneDraft:changed", listener);
        return () => ipcRenderer.removeListener("paneDraft:changed", listener);
      }
    });
    contextBridge.exposeInMainWorld("paneAskApi", {
      /** → açık sorular (PaneAsk[]). */
      list: () => ipcRenderer.invoke("paneAsk:list"),
      /** Seçenek (choiceId) ya da serbest metin (text) → { ok, delivered?, reason?, ask? }. */
      answer: (payload) => ipcRenderer.invoke("paneAsk:answer", payload || {}),
      /** Kartı cevapsız kapat → { ok, reason? }. */
      dismiss: (askId) => ipcRenderer.invoke("paneAsk:dismiss", askId),
      /** Defter değişti (açıldı / hatırlatma / kapandı). cb: { type, ask }. Returns unsubscribe. */
      onChanged: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("paneAsk:changed", listener);
        return () => ipcRenderer.removeListener("paneAsk:changed", listener);
      }
    });
    contextBridge.exposeInMainWorld("composeBridge", {
      // — main → renderer TURLARI (köprü: MCP aracı → main → burası) —
      /** Satır kurma isteği. cb: { requestId, objective, roles, mode, teamName, department, leaderId, maxEmployees, rejectedRoles }. */
      onPropose: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("team-compose:propose", l);
        return () => ipcRenderer.removeListener("team-compose:propose", l);
      },
      /** Cevap: { requestId, ok, teamName?, rows?, targetTeamId?, catalogSlugs?, error? }. */
      proposeResult: (res) => ipcRenderer.send("team-compose:propose:result", res),
      /** Kurulum isteği. cb: { requestId, proposalId, mode, teamName, rows, targetTeamId }. */
      onApply: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("team-compose:apply", l);
        return () => ipcRenderer.removeListener("team-compose:apply", l);
      },
      /** Cevap: { requestId, ok, teamId?, createdTeam?, employeeIds?, names?, … }. */
      applyResult: (res) => ipcRenderer.send("team-compose:apply:result", res),
      /** Geri alma isteği. cb: { requestId, teamId, createdTeam, employeeIds }. */
      onUndo: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("team-compose:undo", l);
        return () => ipcRenderer.removeListener("team-compose:undo", l);
      },
      /** Cevap: { requestId, ok, removedEmployees, removedTeam, error? }. */
      undoResult: (res) => ipcRenderer.send("team-compose:undo:result", res),
      // — KART YÜZEYİ (TC-02 bunları kullanır) —
      /** Onay kartı olayı. cb: { proposalId, mode, teamName, rows, expiresAt, planNote, source, autonomy }. */
      onProposal: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("team-compose:proposal", l);
        return () => ipcRenderer.removeListener("team-compose:proposal", l);
      },
      /** Kurulum sonrası şerit olayı. cb: { proposalId, teamName, names, wingSlug, undoExpiresAt }. */
      onApplied: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("team-compose:applied", l);
        return () => ipcRenderer.removeListener("team-compose:applied", l);
      },
      /**
       * Kullanıcının kararı → main. { proposalId, decision:'approve'|'reject', teamName?, rows?, mode?, catalogSlugs? }
       * Dönen `approvalToken` MAIN'de doğar; kart onu üretemez.
       */
      decide: (req) => ipcRenderer.invoke("team-compose:decision", req),
      /** Ayar kademesi (§9.7): { ok, autonomy:'ask'|'small-auto'|'auto' }. */
      autonomy: () => ipcRenderer.invoke("team-compose:autonomy"),
      /**
       * TC-02 — KULLANICININ şeritten geri alması. §3.6 bunu yalnız main→renderer
       * yönünde tanımlıyordu; şeridin düğmesi ters yönü ister. → { ok, error? }
       */
      undoRequest: (proposalId) => ipcRenderer.invoke("team-compose:undo-request", { proposalId })
    });
    contextBridge.exposeInMainWorld("taskApi", {
      /** Seçili takımın done olan görevlerini sil → { ok, project, deletedCount } */
      cleanTeamDone: (opts) => ipcRenderer.invoke("task:cleanTeamDone", opts),
      /** Tüm takımların bütün görevlerini kalıcı sil → { ok, deletedCount } */
      cleanAll: () => ipcRenderer.invoke("task:cleanAll"),
      /** Görev durum özeti → { ok, total, byProject, tasks } */
      listSummary: () => ipcRenderer.invoke("task:listSummary")
    });
    contextBridge.exposeInMainWorld("planApi", {
      /** → { ok, enforced, tier, tierLabel, fallback, features{agents,integrations,autopilot}, billingUrl }. */
      get: () => ipcRenderer.invoke("plan:get"),
      /**
       * BL-03 — "yükselttim, hâlâ kilitli mi?" → jetonu TAZELE + reddin KENDİ ölçüsünü
       * yeniden karara sok. → { ok, refreshed, allowed, tier, tierLabel, requiredTierLabel }.
       * Karar yine main'dedir (planLimits.decide); burası yalnız reddin (feature,current)
       * çiftini geri taşır — renderer ikinci bir tavan mantığı KURMAZ.
       */
      recheck: (feature, current) => ipcRenderer.invoke("plan:recheck", { feature, current }),
      /** Main bir eylemi plan limiti yüzünden reddettiğinde push eder (kapatılabilir nudge). */
      onLimit: (cb) => {
        const l = (_e, d) => cb(d);
        ipcRenderer.on("plan:limit", l);
        return () => ipcRenderer.removeListener("plan:limit", l);
      }
    });
    contextBridge.exposeInMainWorld("queueBoardApi", {
      /** → { ok, board: {waiting, inflight, done, warnings, counts}, sources }. */
      get: () => ipcRenderer.invoke("queueboard:get")
    });
  }
});

// src/preload/bridges/voice.js
var require_voice = __commonJS({
  "src/preload/bridges/voice.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("jarvisInputSim", {
      run: (action) => ipcRenderer.invoke("jarvis:input-event", action)
    });
    contextBridge.exposeInMainWorld("jarvisScreenCapture", {
      run: (req) => ipcRenderer.invoke("jarvis:screen-capture", req)
    });
    contextBridge.exposeInMainWorld("jarvisApi", {
      /** Capability probe → { ok, hasOpenAiKey, voice, claudeBin, voiceMode, grok }. */
      config: () => ipcRenderer.invoke("jarvis:config"),
      /**
       * ADP-827 (Faz 7) — GROK VOICE oturumu. xAI anahtarı MAIN'de kalır: renderer
       * yalnız 16 kHz PCM16 base64 parçası yollar ve olay alır. `audio` bilerek
       * `send` (invoke DEĞİL) — 20 ms'lik parçada yanıt beklemek kuyruk kurar.
       */
      grok: {
        connect: () => ipcRenderer.invoke("grok:connect"),
        audio: (base64) => ipcRenderer.send("grok:audio", base64),
        /** BİZİM cevabımızı söylet (karar bizde kalır — `force_message`). */
        say: (text) => ipcRenderer.invoke("grok:say", text),
        /** Barge-in: modelin yanıtını kes + yoldaki sesi at. */
        interrupt: () => ipcRenderer.invoke("grok:interrupt"),
        /** Oturumu kapat → { ok, usage:{seconds, usd} } (fatura şeffaflığı). */
        close: () => ipcRenderer.invoke("grok:close"),
        status: () => ipcRenderer.invoke("grok:status"),
        /** Sunucu olayları: ready · transcript · audio · error · closed · usage. */
        onEvent: (cb) => {
          const l = (_e, evt) => cb(evt);
          ipcRenderer.on("grok:event", l);
          return () => ipcRenderer.removeListener("grok:event", l);
        }
      },
      /** STT: base64 audio → { ok, text } | { ok:false, reason }. Whisper, main-side. */
      transcribe: (payload) => ipcRenderer.invoke("jarvis:transcribe", payload),
      /**
       * ADP-813 — YEREL STT ISITMA: kayıt BAŞLADIĞI an çağrılır. whisper.cpp sunucusu
       * ayağa kalkarken (~600 ms + model yükleme) kullanıcı zaten konuşuyor → ilk turun
       * soğuk bedeli (ölçüldü 1301 ms → 549 ms) kullanıcının konuşma süresine gizlenir.
       * Ateşle-unut: dönüşü beklenmeden kayıt devam eder.
       */
      warmupStt: () => ipcRenderer.invoke("jarvis:sttWarmup"),
      /**
       * ADP-815 — KATMAN 2 (kalıcı `claude` beyni) ISITMA: kayıt başlarken çağrılır.
       * Soğuk ilk tur 4–13 s, ısınmış tur p50 2.5 s (ÖLÇÜLDÜ) → bedel kullanıcının
       * konuşma süresine gizlenir. Ateşle-unut; oturum kurulamazsa karar zinciri
       * soğuk `claude -p` yoluna düşer.
       */
      warmupBrain: () => ipcRenderer.invoke("jarvis:brainWarmup"),
      /** ADP-815 — gözcü durumu (e2e/ölçüm): { alive, ready, turns, coldFallbacks, rssMb }. */
      brainStats: () => ipcRenderer.invoke("jarvis:brainStats"),
      /** ADP-815 — kalıcı oturumu KASTEN öldür (çökme→soğuk-yol testinin kaçış kapısı). */
      brainKill: (payload) => ipcRenderer.invoke("jarvis:brainKill", payload),
      /**
       * ADP-814 — AKIŞ STT: kayıt SÜRERKEN o ana kadarki kümülatif ses → hızlı `base`
       * modelinden kısmi hipotez (ölçüldü p50 ~136 ms). Yalnız EKRANA yazılır; komut
       * olarak asla çalıştırılmaz. Yerel yol kapalıysa sebep döner (bulut kullanılmaz).
       */
      transcribePartial: (payload) => ipcRenderer.invoke("jarvis:transcribePartial", payload),
      /**
       * ADP-816 (Faz 4) — TAŞINABİLİR SES WIDGET'I (ayrı, frameless, always-on-top
       * pencere). Bu köprü YALNIZ pencere + görüntü taşır: ses/kayıt/karar zincirine
       * hiçbir ucu dokunmaz. Widget penceresinin renderer'ı da AYNI preload'u yükler,
       * yani `snapshot`/`onChanged`/`move` uçlarını oradan çağırır.
       */
      widget: {
        /** Widget penceresini aç (odak ÇALMAZ — main showInactive kullanır). */
        open: () => ipcRenderer.invoke("jarvisWidget:open"),
        close: () => ipcRenderer.invoke("jarvisWidget:close"),
        toggle: () => ipcRenderer.invoke("jarvisWidget:toggle"),
        isOpen: () => ipcRenderer.invoke("jarvisWidget:isOpen"),
        /** ANA pencere → main: ses yüzeyinin son durumu (durum, kısmi metin, son çift). */
        publish: (snapshot) => ipcRenderer.invoke("jarvisWidget:publish", snapshot),
        /** WIDGET penceresi → main: mount'ta son fotoğraf (boş açılmasın). */
        snapshot: () => ipcRenderer.invoke("jarvisWidget:snapshot"),
        /** WIDGET penceresi: sürükleme deltası (frameless pencerenin taşınma yolu). */
        move: (delta) => ipcRenderer.invoke("jarvisWidget:move", delta),
        /** WIDGET penceresi: ana pencereyi göster/yeniden yarat (kullanıcı tıklaması). */
        showApp: () => ipcRenderer.invoke("jarvisWidget:showApp"),
        /** e2e/ölçüm: pencerenin GERÇEK bayrakları (alwaysOnTop/focusable/bounds). */
        debug: () => ipcRenderer.invoke("jarvisWidget:debug"),
        /** WIDGET penceresi: durum fotoğrafı değişti. Returns unsubscribe. */
        onChanged: (cb) => {
          const l = (_e, snapshot) => cb(snapshot);
          ipcRenderer.on("jarvisWidget:changed", l);
          return () => ipcRenderer.removeListener("jarvisWidget:changed", l);
        },
        /** ANA pencere: widget açıldı/kapandı (düğme gerçeği yansıtsın). */
        onOpenState: (cb) => {
          const l = (_e, payload) => cb(payload);
          ipcRenderer.on("jarvisWidget:openState", l);
          return () => ipcRenderer.removeListener("jarvisWidget:openState", l);
        }
      },
      /** Brain: { transcript, context } → { ok, decision, via } (claude or rule). */
      think: (payload) => ipcRenderer.invoke("jarvis:think", payload),
      /** TTS: { text, play? } → { ok, path, bytes, ms } | { ok:false }. Uses settings engine. */
      speak: (payload) => ipcRenderer.invoke("jarvis:speak", payload),
      /** Preview a specific TTS voice with a sample sentence. { voice } → { ok, ... }. */
      preview: (payload) => ipcRenderer.invoke("jarvis:tts-preview", payload),
      /** List available TTS voices → string[]. */
      voices: () => ipcRenderer.invoke("jarvis:voices"),
      /**
       * ADP-848-B — ElevenLabs ses listesi KULLANICININ hesabından çekilir
       * ({ engine:'elevenlabs' } → { ok, voices, counts, status }). Sır DÖNMEZ.
       * Anahtar yoksa/çağrı patlarsa `status` ne olduğunu Türkçe söyler.
       */
      voiceList: (payload) => ipcRenderer.invoke("jarvis:tts-voice-list", payload),
      /**
       * AGENTX-RT-3 — AKAN TTS. `speak` SON baytı bekler; bu İLK baytı yollar.
       * Dönüş özet ({ ok, cached, firstByteMs, bytes, groups, ms }); ses PARÇALARI
       * `onSpeechChunk` ile akar. Önbellekte varsa akış YOKTUR ve `audioBase64`
       * doğrudan döner (ADP-812 yolu korunur).
       * Eski preload'larda YOK → çağıran `?.` ile korur: köprü yoksa ses sessizce
       * eski (bekleyen) yoldan çıkar, zincir kırılmaz.
       */
      speakStream: (payload) => ipcRenderer.invoke("jarvis:speakStream", payload),
      /** Akan TTS'in PCM parçaları ({ streamId, index, base64, rate, first }). Returns unsubscribe. */
      onSpeechChunk: (cb) => {
        const l = (_e, chunk) => cb(chunk);
        ipcRenderer.on("jarvis:speech-chunk", l);
        return () => ipcRenderer.removeListener("jarvis:speech-chunk", l);
      },
      /** Akan TTS'i kes: yoldaki HTTP isteği de iptal edilir (jeton/bant yanmaz). */
      cancelSpeakStream: (streamId) => ipcRenderer.send("jarvis:speakStreamCancel", streamId),
      /** Barge-in / Esc — stop any in-flight playback. */
      stopSpeaking: () => ipcRenderer.send("jarvis:stopSpeaking"),
      // ADP-317 — KONUŞMA DEFTERİ (tek gerçek main'de). Panel de telefon da buradan
      // beslenir: masaüstünde yazılan satır telefona, telefondan gelen satır panele düşer.
      conv: {
        /** Defterin tamamı → { turns, approvals } (mount'ta hydrate; restart'ı atlatır). */
        get: () => ipcRenderer.invoke("jarvis:conv:get"),
        /** Satır ekle → { id, who, text, source, action, at } (idempotent: aynı id yok sayılır). */
        append: (turn) => ipcRenderer.invoke("jarvis:conv:append", turn),
        /** Onay kartı aç — İKİ uçta birden görünür. */
        openApproval: (approval) => ipcRenderer.invoke("jarvis:conv:approval", approval),
        /** Onayı kapat. null dönerse: BAŞKA uç zaten cevaplamış (çift çalıştırma yok). */
        resolve: (payload) => ipcRenderer.invoke("jarvis:conv:resolve", payload),
        clear: () => ipcRenderer.invoke("jarvis:conv:clear"),
        /** Defter değişti (satır/onay/çözüm) → canlı akış. Returns unsubscribe. */
        onChanged: (cb) => {
          const l = (_e, event) => cb(event);
          ipcRenderer.on("jarvis:conv:changed", l);
          return () => ipcRenderer.removeListener("jarvis:conv:changed", l);
        }
      },
      /** Global hotkey (toggle activation) pushed from main. Returns unsubscribe. */
      onHotkey: (cb) => {
        const l = () => cb();
        ipcRenderer.on("jarvis:hotkey", l);
        return () => ipcRenderer.removeListener("jarvis:hotkey", l);
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
        deliver: (req) => ipcRenderer.invoke("agentx:deliver", req),
        /** Teslimsiz hedef çözümü (HEDEF SORUSU'ndan önce): { target, ctx } → resolveTarget çıktısı. */
        resolve: (req) => ipcRenderer.invoke("agentx:resolve", req),
        /** AXP-14 — uçuş-öncesi yoklama (yazmaz): { target, ctx } → { resolved, pane, state: idle|busy|menu|fresh|text|none }. */
        probe: (req) => ipcRenderer.invoke("agentx:probe", req),
        /** "Son işlemler" — oturum içi makbuz defteri (en yeni önde). */
        receipts: () => ipcRenderer.invoke("agentx:receipts"),
        retry: (id) => ipcRenderer.invoke("agentx:retry", id),
        cancel: (id) => ipcRenderer.invoke("agentx:cancel", id),
        /** Makbuz üretildi/değişti (ana pencere + pop-out aynı olayı dinler). Returns unsubscribe. */
        onReceipt: (cb) => {
          const l = (_e, receipt) => cb(receipt);
          ipcRenderer.on("agentx:receipt", l);
          return () => ipcRenderer.removeListener("agentx:receipt", l);
        },
        // ── AXP-04 — IŞIK ─────────────────────────────────────────────────────────
        /** Kaynak ölçümü: {orbCss} (ana pencere CSS px) → {ok, mode, origin, drawOrigin, overlay, mainContent, mainZoom}. */
        beamSource: (p) => ipcRenderer.invoke("agentx:beam:source", p),
        /** Pencere DIŞI parça için masaüstü katmanı (yalnız macOS + popout-outside). */
        beamShow: (seg) => ipcRenderer.invoke("agentx:beam:show", seg),
        beamClear: () => ipcRenderer.invoke("agentx:beam:clear"),
        /** POP-OUT penceresi: main gösterge dikdörtgenini ister; cevap `beamMeasured` ile. Returns unsubscribe. */
        onBeamMeasure: (cb) => {
          const l = (_e, p) => cb(p);
          ipcRenderer.on("agentx:beam:measure", l);
          return () => ipcRenderer.removeListener("agentx:beam:measure", l);
        },
        beamMeasured: (p) => ipcRenderer.send("agentx:beam:measured", p)
      }
    });
  }
});

// src/preload/bridges/files.js
var require_files = __commonJS({
  "src/preload/bridges/files.js"() {
    "use strict";
    var { contextBridge, ipcRenderer, webUtils } = require("electron");
    contextBridge.exposeInMainWorld("imageApi", {
      saveTemp: (payload) => ipcRenderer.invoke("image:saveTemp", payload),
      /** → { ok, missing:[], foreign:[], present:[] } */
      verify: (paths) => ipcRenderer.invoke("image:verify", paths)
    });
    contextBridge.exposeInMainWorld("attachmentApi", {
      /**
       * Bir görseli depoya al. `path` (native drop / MCP) YA DA `data` (⌘V, dosya
       * seçici) verilir. → { ok, sha256, mime, bytes, width, height, localRelPath,
       * thumbDataUrl, originDevice, title, kind, source } | { ok:false, reason }
       */
      ingest: (payload) => ipcRenderer.invoke("attachment:ingest", payload),
      /** local_rel_path → { ok, dataUrl, mime, bytes } | { ok:false, reason:'missing' } */
      read: (relPath) => ipcRenderer.invoke("attachment:read", relPath),
      /** → { ok, present } — tam çözünürlük BU cihazda var mı? */
      hasBytes: (relPath) => ipcRenderer.invoke("attachment:hasBytes", relPath),
      /** Baytları diskten sil (satırın tombstone'u ÇAĞIRANIN işi). */
      removeBytes: (relPath) => ipcRenderer.invoke("attachment:removeBytes", relPath)
    });
    contextBridge.exposeInMainWorld("officePackApi", {
      /** → { ok, path, bytes, sha256 } | { ok:false, error } */
      exportPack: (pack, skills) => ipcRenderer.invoke("office:exportPack", { pack, skills }),
      /** → { ok, pack, skills:[{name,text,sha256,bytes}], warnings } | { ok:false, error } */
      readPack: (zipPath) => ipcRenderer.invoke("office:readPack", zipPath)
    });
    contextBridge.exposeInMainWorld("fileDropApi", {
      /** Resolve a dropped File's absolute on-disk path (replaces removed File.path). */
      getPathForFile: (file) => {
        try {
          return webUtils && typeof webUtils.getPathForFile === "function" ? webUtils.getPathForFile(file) : "";
        } catch {
          return "";
        }
      }
    });
    contextBridge.exposeInMainWorld("fileApi", {
      /** Read a workspace file as UTF-8 → { ok, content, encoding, path } | { ok:false, reason }. */
      read: (p) => ipcRenderer.invoke("file:read", p),
      /** Write UTF-8 content to a workspace file → { ok, bytes, path } | { ok:false, reason }. */
      write: (p, content) => ipcRenderer.invoke("file:write", { path: p, content }),
      /** List a workspace directory → { ok, dir, entries:[{name,path,type}] } | { ok:false, reason }. */
      list: (dir) => ipcRenderer.invoke("file:list", dir),
      /**
       * ADP-103 — open the OS directory picker; the chosen dir becomes a new active root
       * (the only way to browse outside the workspace) → { ok, root, name } | { ok:false, reason }.
       */
      openDialog: () => ipcRenderer.invoke("file:openDialog"),
      /**
       * ADP-108 — live-watch: grant the editor read access to a WATCHED pane's cwd and
       * learn that cwd (+ home + workspace root) so the renderer can rebase the relative
       * path the agent prints to the absolute file it wrote → { ok, cwd, home,
       * workspaceRoot } | { ok:false, reason }. Keyed to a main-spawned paneId (no path
       * is supplied by the renderer), so the ADP-103 sandbox model is preserved.
       */
      allowPaneRoot: (paneId) => ipcRenderer.invoke("file:allowPaneRoot", paneId),
      /**
       * ADP-109 — editor start-experience persistence (last-session + recent). SYNC get
       * (so the renderer reads it during mount without an async flash) + async set. Stored
       * in userData main-side because the embedded server's RANDOM per-launch port makes
       * the renderer origin (and thus localStorage) change on every restart.
       */
      getEditorState: () => ipcRenderer.sendSync("file:editorState:get"),
      setEditorState: (state) => ipcRenderer.invoke("file:editorState:set", state)
    });
    contextBridge.exposeInMainWorld("clipboardApi", {
      /** Düz metni panoya yaz → { ok } (main tarafında boy sınırlı). */
      write: (text) => ipcRenderer.invoke("clipboard:write", text),
      /**
       * ADP-894 — ODAKLI yüzeye YAPIŞTIR → { ok, kind }. Windows'ta Ctrl+V'yi xterm
       * `\x16` olarak yutuyor (ölçüldü) → yapıştırma hiç çalışmıyordu; macOS'ta
       * aynı işi Electron'un varsayılan Edit menüsü `webContents.paste()` ile
       * yapıyor. Bu uç o menü öğesinin ta kendisidir.
       *
       * ADP-925 — panoda GÖRÜNTÜ varsa (ve metin yoksa) main bir TESLİMAT DİREKTİFİ
       * döner; `paneId` verilirse motoruna göre karar verir:
       *   • `{ kind:'engine-keys', keys }` → çağıran bu baytı pane'e YAZAR; motor
       *     panoyu kendisi okur (ölçüldü: claude `\x16` → `[Image #1]`).
       *   • `{ kind:'image', path }`       → main görüntüyü temp PNG'ye yazdı;
       *     çağıran YOLU pane'e yapıştırır (kabuk pane'leri).
       *   • `{ kind:'text' }`              → metin yolu main'de zaten koştu.
       *
       * GÜVENLİK: pano İÇERİĞİ renderer'a GEÇMEZ — metinde main yalnız yerel
       * "yapıştır" komutunu çalıştırır; görüntüde geçen şey ya sabit bir kontrol
       * baytı ya da temp dosya YOLUdur. "Okuma ucu yok" duruşu (yukarıda) korunur.
       */
      pasteFocused: (opts) => ipcRenderer.invoke("clipboard:pasteFocused", opts)
    });
    contextBridge.exposeInMainWorld("clipApi", {
      /** → { ok, items:[{id,kind,at,preview,chars,width,height,bytes,thumb}] } (en yeni başta). */
      list: () => ipcRenderer.invoke("clip:list"),
      /**
       * Öğeyi panoya geri koy + pane'e nasıl ineceğini söyle → aynı sözleşme
       * `clipboard:pasteFocused` ile (ADP-925):
       *   • `{ kind:'text', text }`        → çağıran metni pane'e YAPIŞTIRIR (Enter YOK)
       *   • `{ kind:'engine-keys', keys }` → çağıran kontrol baytını yazar, motor panoyu okur
       *   • `{ kind:'image', path }`       → çağıran temp PNG YOLUnu yapıştırır (kabuk pane'i)
       */
      deliver: (itemId, paneId) => ipcRenderer.invoke("clip:deliver", { itemId, paneId }),
      /** Tek öğeyi geçmişten sil → { ok }. */
      remove: (itemId) => ipcRenderer.invoke("clip:remove", itemId),
      /** Geçmişin tamamını sil → { ok, removed }. */
      clear: () => ipcRenderer.invoke("clip:clear"),
      /** Geçmiş değişti (yeni kopya / silme). Aboneliği bırakan fonksiyon döner. */
      onChanged: (cb) => {
        const listener = () => cb();
        ipcRenderer.on("clip:changed", listener);
        return () => ipcRenderer.removeListener("clip:changed", listener);
      }
    });
    contextBridge.exposeInMainWorld("officeStateApi", {
      get: () => ipcRenderer.sendSync("office:state:get"),
      set: (state) => ipcRenderer.invoke("office:state:set", state)
    });
  }
});

// src/preload/bridges/services.js
var require_services = __commonJS({
  "src/preload/bridges/services.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("designApi", {
      /** Tasarım turunu ayrı pencerede aç (zaten açıksa öne getirir). → { ok, reused? } | { ok:false, error }. */
      openWindow: () => ipcRenderer.invoke("design:openWindow"),
      /** Tasarım penceresini kapat. → { ok } | { ok:false, error }. */
      closeWindow: () => ipcRenderer.invoke("design:closeWindow"),
      /** Pencere şu an açık mı → { open }. */
      isWindowOpen: () => ipcRenderer.invoke("design:isWindowOpen"),
      /** Pencere açıldı/kapandı (giriş düğmesi gerçeği yansıtsın). cb gets { open }. Returns unsubscribe. */
      onOpenState: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("design:openState", listener);
        return () => ipcRenderer.removeListener("design:openState", listener);
      },
      /**
       * AUID-M4A (ARIZA-1) — TÜM pencerelerdeki ajan-bağlı pane'ler. `ptyApi.list`
       * SAHİP PENCEREYE göre süzer ve tasarım penceresi hiçbir pty'nin sahibi
       * olmadığı için ona hep BOŞ dönüyordu. → { ok, panes }.
       */
      listAgents: () => ipcRenderer.invoke("design:listAgents"),
      /**
       * AUID-M4A — bir tasarım görevi klasörü aç (`docs/design/<görev>`). `fileApi`
       * mkdir yapamaz; demo tohumu ve üretim modu buna muhtaç. → { ok, created }.
       */
      ensureTaskDir: (rel) => ipcRenderer.invoke("design:ensureTaskDir", rel)
    });
    contextBridge.exposeInMainWorld("codeIntelApi", {
      /** Diff one file vs HEAD → { ok, tracked, relPath, committedText, added, modified, removed, summary }. */
      diff: (filePath) => ipcRenderer.invoke("git:diff", filePath),
      /** Files in the active workspace (scoped to its git repo) → { ok, files:[path…] }.
       *  `root` (TASK-MQTIVZSDYPNRH) = the editor's active file/folder; main scopes to it. */
      listFiles: (root) => ipcRenderer.invoke("workspace:listFiles", root),
      /** Literal case-insensitive content search in the active workspace → { ok, hits:[{file,
       *  line, text}], truncated }. `root` scopes the search (active file/folder). */
      grep: (query, root) => ipcRenderer.invoke("workspace:grep", { query, root }),
      /** ADP-402 — pane header git-branch rozeti: cwd → saran repo'nun branch'i
       *  ({ ok, branch: string|null }; git değilse/root dışıysa branch yok). */
      // B-02 — `opts.force` TTL cache'ini atlar: görev değişimi / attach / merge
      // sonrası rozet 5 saniye bayat kalmasın (poll YOK, yalnız olay).
      branch: (cwd, opts) => ipcRenderer.invoke("git:branch", cwd, opts)
    });
    contextBridge.exposeInMainWorld("worktreeApi", {
      /** → { ok, worktrees:[{taskId, project, code, branch, path, baseCommit, owner, state, livePaneId}] } */
      list: () => ipcRenderer.invoke("worktree:list"),
      /**
       * İnceleme kartının verisi — HİÇBİR ŞEYİ DEĞİŞTİRMEZ.
       * → { ok, branch, target, commitCount, commits, files, diffStat, conflict, conflictFiles,
       *     secretScan:{ok,findings}, approval:{approver,auto,blocked,why}, preconditions }
       * `secretScan.findings` yalnız DOSYA + TÜR taşır; sırrın DEĞERİ asla dönmez (G-4).
       */
      review: (input) => ipcRenderer.invoke("worktree:review", input),
      /** Merge et. Kapılar burada TEKRAR koşar; `approvedBy:true` patron onayıdır. */
      merge: (input) => ipcRenderer.invoke("worktree:merge", input),
      /** Merge sonrası ağacı kaldır. Kirli ağaç yalnız `force:true` ile (patron onayı, G-9). */
      release: (input) => ipcRenderer.invoke("worktree:release", input),
      /** Temizlik taraması: kayıp/bayat kayıtlar + defter DIŞI yönetilen ağaçlar. */
      reap: () => ipcRenderer.invoke("worktree:reap")
    });
    contextBridge.exposeInMainWorld("codeIndexApi", {
      /**
       * → { ok, installed, binPath, binName, installUrl,
       *     projects:[{slug, repoPath, enabled, indexedSha, lastIndexedAt,
       *                state:'not-indexed'|'fresh'|'stale'|'unknown', staleFiles, indexing}] }
       * `state:'unknown'` "ölçemedim" demektir ve "taze" diye YUVARLANMAZ (CIDX-0 §4b).
       */
      list: (slugs) => ipcRenderer.invoke("codeIndex:list", { slugs }),
      /** { slug, enabled } → { ok, enabled, persisted, restartHint }. */
      set: (slug, enabled) => ipcRenderer.invoke("codeIndex:set", { slug, enabled }),
      /** Arka planda indeksle → { ok, started, repoPath } | { ok:false, why }. */
      index: (slug) => ipcRenderer.invoke("codeIndex:index", { slug }),
      /** İlerleme/bitiş: { slug, running, ok?, exitCode?, tail? }. */
      onProgress: (cb) => {
        const handler = (_e, payload) => cb(payload);
        ipcRenderer.on("codeIndex:progress", handler);
        return () => ipcRenderer.removeListener("codeIndex:progress", handler);
      }
    });
    contextBridge.exposeInMainWorld("sprintApi", {
      /** run objesini kalıcıla → { ok, file? , error? }. */
      save: (run) => ipcRenderer.invoke("sprint:save", run),
      /** id → { ok, run|null }. */
      load: (id) => ipcRenderer.invoke("sprint:load", id),
      /** → { ok, runs: [{id, settled, updatedAt, objective, taskCount}] }. */
      list: () => ipcRenderer.invoke("sprint:list"),
      /**
       * DF-03 — ÇOK-ADAYLI kanıt sondası (supervisor'ın ADP-735 çözümünün aynısı).
       * { department?, items:[{taskId, evidencePath, agentId?, since?}] }
       *   → { ok, items:[{taskId, found, path?, mtimeMs?, stale?}] }
       * Renderer'ın tek-köklü `fileApi` sondası kurulu makinede YANLIŞ köke bakıyordu.
       */
      probeEvidence: (req) => ipcRenderer.invoke("sprint:evidence", req),
      /**
       * RES-IDX-01 — SONUÇ KÖKÜ görevin projesinden (main `resultRoot.cjs`; renderer tahmin
       * etmez). { project?, codes?:[…] } → { ok, root, source, fallback, existing:[…], hasIndexScript }.
       * Worker'a rapor yolu bu kökle MUTLAK + TEK yazılır; supervisor aynı kökü birincil
       * aday yapar (BUG-R3 #8: raporlar üç yere düşüyordu).
       */
      resultRoot: (req) => ipcRenderer.invoke("sprint:resultRoot", req)
    });
    contextBridge.exposeInMainWorld("searchApi", {
      /**
       * → { ok:true, groups:{ [type]: { total, hits:[{type,key,title,path,line,snippet,meta,mtime,score}] } },
       *     total, ms, fts } | { ok:false, reason:'index_not_built'|'fts_unavailable'|… }
       * `ok:false` "sonuç yok" DEĞİLDİR — indeks kurulmadıysa arayüz bunu söylemeli.
       */
      query: (payload) => ipcRenderer.invoke("searchIndex:query", payload),
      /** → { running, phase, sessionsEnabled, dbFile, dbBytes, stats, lastResult }. */
      status: () => ipcRenderer.invoke("searchIndex:status"),
      /** Arka plan kurulumunu başlat → { ok, dbFile } | { ok:false, reason }. */
      reindex: () => ipcRenderer.invoke("searchIndex:reindex"),
      /** Board anlık görüntüsü (işçi Supabase'e bağlanmaz) → { ok, rows }. */
      syncTasks: (rows) => ipcRenderer.invoke("searchIndex:syncTasks", rows),
      /** OPT-OUT: false → oturum belgeleri indeksten SİLİNİR (gizlenmez). */
      setSessionsEnabled: (enabled) => ipcRenderer.invoke("searchIndex:setSessionsEnabled", enabled),
      /** İlerleme akışı: { phase:'start'|'progress'|'done'|'error'|'exit', source?, … }. */
      onEvent: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("searchIndex:event", listener);
        return () => ipcRenderer.removeListener("searchIndex:event", listener);
      }
    });
  }
});

// src/preload/bridges/hand.js
var require_hand = __commonJS({
  "src/preload/bridges/hand.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("handOverlayApi", {
      /** Tespit kaynağı → main: telemetri olay(lar)ı. Katman kapalıysa (ayar açıkken) açar. */
      feed: (events) => ipcRenderer.invoke("handOverlay:feed", events),
      /** OVERLAY penceresi mount'ta: hangi ekran, hangi yoğunluk. */
      init: () => ipcRenderer.invoke("handOverlay:init"),
      isOpen: () => ipcRenderer.invoke("handOverlay:isOpen"),
      close: () => ipcRenderer.invoke("handOverlay:close"),
      /** OVERLAY penceresi → main: çizim bedeli (ms/kare) — log + rapor için. */
      cost: (payload) => ipcRenderer.invoke("handOverlay:cost", payload),
      /** e2e/kanıt: pencerelerin gerçek bayrakları (alwaysOnTop/bounds/görünürlük). */
      debug: () => ipcRenderer.invoke("handOverlay:debug"),
      /** OVERLAY penceresi: telemetri olayları geldi. Returns unsubscribe. */
      onEvents: (cb) => {
        const l = (_e, events) => cb(events);
        ipcRenderer.on("handOverlay:events", l);
        return () => ipcRenderer.removeListener("handOverlay:events", l);
      },
      /** OVERLAY penceresi: ayar (yoğunluk) canlı değişti. Returns unsubscribe. */
      onConfig: (cb) => {
        const l = (_e, overlay) => cb(overlay);
        ipcRenderer.on("handOverlay:config", l);
        return () => ipcRenderer.removeListener("handOverlay:config", l);
      }
    });
    contextBridge.exposeInMainWorld("handDetectApi", {
      /** Sayfa ısınmayı bitirdi (kamerasız): { ms, delegate }. */
      ready: (info) => ipcRenderer.invoke("handDetect:ready", info),
      /** 30 Hz tespit karesi: { t, hand, landmarks:[{x,y}×21], hands:[[{x,y}×21]×n] }
       *  — fire-and-forget. `hands` HAND-G1 iki-el zoom girdisi; `landmarks` tek-el
       *  yolu için KALIR. Yük BÜTÜN olarak geçer (alan beyaz listesi YOK) — yeni
       *  alan burada düşmez, şekil nöbeti main'de (handControlCore/onFrame). */
      frame: (payload) => ipcRenderer.send("handDetect:frame", payload),
      /** HAND-BUG-01 — cihaz seçim planı: sayfa enumerateDevices() sonucunu (+ varsa
       *  ölçtüğü kare istatistiklerini) verir, main SIRALI aday listesini döndürür.
       *  Karar main'de (handCameraPolicy) — sayfa yalnız uygular. */
      plan: (payload) => ipcRenderer.invoke("handDetect:plan", payload),
      /** Kamera yaşam döngüsü: { status: 'started'|'stopped'|'blank'|'error',
       *  label?, deviceId?, kind?, dead?, deadReason?, stats?, error? }. */
      camera: (info) => ipcRenderer.invoke("handDetect:camera", info),
      /** main → sayfa komutları: { cmd: 'start-camera'|'stop-camera' }. */
      onCommand: (cb) => {
        const l = (_e, msg) => cb(msg);
        ipcRenderer.on("handDetect:command", l);
        return () => ipcRenderer.removeListener("handDetect:command", l);
      }
    });
    contextBridge.exposeInMainWorld("handControlApi", {
      start: () => ipcRenderer.invoke("handControl:start"),
      stop: () => ipcRenderer.invoke("handControl:stop"),
      status: () => ipcRenderer.invoke("handControl:status"),
      /** HAND-BUG-01 — rozetteki cihaz seçici. { deviceId, label } ya da null
       *  (null = otomatik seçime dön). Seçim KALICI ayara yazılır. */
      selectCamera: (sel) => ipcRenderer.invoke("handControl:selectCamera", sel),
      /** Rozet canlı durumu (her faz değişiminde yayınlanır). Returns unsubscribe. */
      onStatus: (cb) => {
        const l = (_e, st) => cb(st);
        ipcRenderer.on("handControl:status", l);
        return () => ipcRenderer.removeListener("handControl:status", l);
      },
      // ── HAND-G4 — AYAR KLİNİĞİ (poz örnekleyici + kanyon) ─────────────────────
      /** `{ms?, label?}` → süre dolunca `{ok, frames, fps, metrics:{ad:{min,med,max,n}}}`.
       *  Kamera karesi ya da landmark DÖNMEZ — yalnız kapı metriklerinin özeti. */
      samplePose: (opts) => ipcRenderer.invoke("handControl:samplePose", opts || {}),
      /** İki özet → metrik metrik bantlar + kanyonlar + önerilen kesim. */
      compareSamples: (a, b) => ipcRenderer.invoke("handControl:compareSamples", { a, b }),
      // ── HAND-G2 — UYGULAMA İÇİ ZOOM ────────────────────────────────────────────
      // Beyaz liste KAPIDIR: bu iki satır olmadan zoom sessizce ölür ve kullanıcı
      // hatayı göremez ([[preload-whitelist-is-a-gate]]).
      /** Öndeki sekmenin zoom yüzeyi: 'office' | 'terminal' | null (yüzey yok).
       *  main hangi sekmenin önde olduğunu bilemez — pencere kendi bildirir. */
      reportZoomSurface: (surface) => ipcRenderer.invoke("handControl:zoomSurface", surface),
      /** main → pencere zoom yükü: { phase, surface, scale, delta, x, y }.
       *  Yalnız CrewPane ÖNDEYKEN gelir; değilken zoom OS'a iner (HAND-G1). */
      onZoom: (cb) => {
        const l = (_e, payload) => cb(payload);
        ipcRenderer.on("handControl:zoom", l);
        return () => ipcRenderer.removeListener("handControl:zoom", l);
      }
    });
  }
});

// src/preload/bridges/mobile.js
var require_mobile = __commonJS({
  "src/preload/bridges/mobile.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("mobileBridge", {
      /** main'in veri sorularını dinle. cb: ({ requestId, kind }) => void */
      onQuery: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("mobile:query", l);
        return () => ipcRenderer.removeListener("mobile:query", l);
      },
      /** Cevap: { requestId, data }. */
      queryResult: (res) => ipcRenderer.send("mobile:query:result", res),
      /** Canlı olay (MobileEvent) → SSE. */
      event: (event) => ipcRenderer.send("mobile:event", event),
      /**
       * ADP-296 — YAZMA komutları (prompt/delegate/tasks/jarvis/approve/stop). Renderer
       * MEVCUT motorları çağırır; gateway yalnız taşır. cb: ({ requestId, kind, payload }).
       */
      onCommand: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("mobile:command", l);
        return () => ipcRenderer.removeListener("mobile:command", l);
      },
      /** Cevap: { requestId, result }. */
      commandResult: (res) => ipcRenderer.send("mobile:command:result", res)
    });
    contextBridge.exposeInMainWorld("mobileAdmin", {
      status: () => ipcRenderer.invoke("mobile:status"),
      enable: () => ipcRenderer.invoke("mobile:enable"),
      disable: () => ipcRenderer.invoke("mobile:disable"),
      createPairing: () => ipcRenderer.invoke("mobile:pair"),
      // MOB-UX-M1 (M1-b) — sihirbazın ölçümü: { tailnet:{state,address?,dnsName?},
      // gateway:{running,…}, peers:{available,phones?} }. Gateway KAPALIYKEN de çalışır.
      probe: () => ipcRenderer.invoke("mobile:probe"),
      revoke: (deviceId) => ipcRenderer.invoke("mobile:revoke", deviceId),
      // ADP-308 — cihaz yetkisi read ⇄ command (yalnız masaüstünden; telefonun kendini
      // yükseltebileceği bir rota YOK — ADP-293 §4 kapsam kuralı).
      setScope: (deviceId, scope) => ipcRenderer.invoke("mobile:scope", deviceId, scope)
    });
  }
});

// src/preload/bridges/settings.js
var require_settings = __commonJS({
  "src/preload/bridges/settings.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("projectConfigApi", {
      /** → { ok, workspaceRoot, projects:[{slug, isolation, defaultBranch, repoPath, repoSource}] } */
      get: (slugs) => ipcRenderer.invoke("project:config:get", { slugs }),
      /** { slug, isolation:'worktree'|'off', defaultBranch? } → { ok, persisted, branchSaved, repoPath, why } */
      set: (input) => ipcRenderer.invoke("project:config:set", input)
    });
    contextBridge.exposeInMainWorld("settingsApi", {
      /** → { ok, workspaceRoot, resolvedWorkspaceRoot, repoRoot, firstRunRequired, defaultWorkspaceDir, pushToTalkKey, pushToTalkKeys, wakeModelPath, hasOpenAiKey, mcpServers, theme }. */
      get: () => ipcRenderer.invoke("settings:get"),
      /** Merge-patch + persist. patch = { workspaceRoot?, apiKeys?:{openai?,…}, pushToTalkKey?, wakeModelPath?, mcpServers?, theme?, notifications?, engines?:{<id>:{vendorHosted:'allow'|'block'}} }. */
      set: (patch) => ipcRenderer.invoke("settings:set", patch),
      /**
       * SKL-B3 — ürünün KENDİ API anahtarını (bugün: gemini) GERÇEKTEN sağlayıcıya sorar.
       * Renderer yalnız SERVİS ADINI verir; anahtar bu köprüden hiçbir yönde geçmez.
       * → { ok:true, source, status, count } | { ok:false, reason:'no-key'|'rejected'|
       *    'unreachable'|'unsupported', … }
       */
      verifyAppKey: (service) => ipcRenderer.invoke("appkey:verify", service),
      /**
       * ADP-232-C — ilk-açılış "çalışma alanı seç": { mode:'create'|'pick' }.
       * 'create' önerilen ~/CrewPane'i oluşturur; 'pick' OS klasör dialog'u açar
       * (yol renderer'dan asla gelmez). → { ok, root, restartRequired } | { ok:false, reason }.
       */
      provisionWorkspace: (req) => ipcRenderer.invoke("workspace:provision", req),
      /**
       * ADP-232-B — CANLI çalışma alanı geçişi (yeniden başlatmadan). req:
       *   { mode:'pick' }    → OS klasör dialog'u (yol renderer'dan gelmez),
       *   { mode:'current' } → Ayarlar'ın settings.workspaceRoot'a yazdığı kökü canlı uygula,
       *   { root:'…' }       → doğrudan yol (Ayarlar input'u; settings:set ile aynı güven sınırı).
       * → { ok, root, previous, changed, grandfathered[] } | { ok:false, reason }.
       * Açık pane'ler/çalışan işler ESKİ kökte kalır; yeni işler yeni kökte açılır.
       */
      switchWorkspace: (req) => ipcRenderer.invoke("workspace:switch", req),
      /**
       * ADP-737 — TAKIM KAPSAMI KAPISI (renderer ucu). Delegasyon yolunda her worker'ın
       * KENDİ takımı için sorulur: hedef takım liderin takımı değilse main sahibe onay
       * kartı çıkarır ve cevabı bekler. Karar renderer'da ASLA verilmez — burada yalnız
       * sorulur (`{action:'delegate'|'manage', leaderId, targetScope}` → `{ok, code?, reason?}`).
       */
      authorizeTeamScope: (req) => ipcRenderer.invoke("teamScope:authorize", req),
      /**
       * ADP-888 — ARAYÜZ DİLİ canlı değişince main push eder: cb({ locale, preference }).
       * Route değişmez, ağaç yeniden render olur → açık pane/terminal durumu KORUNUR.
       * Returns unsubscribe.
       */
      onLocaleChanged: (cb) => {
        const l = (_e, payload) => cb(payload || {});
        ipcRenderer.on("app:locale-changed", l);
        return () => ipcRenderer.removeListener("app:locale-changed", l);
      },
      /** ADP-232-B — kök CANLI değişince main push eder: cb({ root, previous, grandfathered[], at }). Returns unsubscribe. */
      onWorkspaceChanged: (cb) => {
        const l = (_e, payload) => cb(payload || {});
        ipcRenderer.on("workspace:changed", l);
        return () => ipcRenderer.removeListener("workspace:changed", l);
      }
    });
    contextBridge.exposeInMainWorld("updateApi", {
      /** → { checked, updateAvailable, latestVersion, currentVersion, lastCheckedAt, autoCheck, dismissed, downloadUrl, mode, phase, progressPercent }. */
      get: () => ipcRenderer.invoke("update:get"),
      /** Manuel kontrol (Ayarlar "Şimdi kontrol et"; toggle'dan bağımsız koşar). → aynı durum nesnesi. */
      checkNow: () => ipcRenderer.invoke("update:checkNow"),
      /** updater modu: uygulama içinde indir (progress push'ları gelir); notify modu: tarayıcıda SABİT DMG URL'i. */
      download: () => ipcRenderer.invoke("update:download"),
      /** ADP-553 — İNDİRİLMİŞ güncellemeyi kullanıcı onayıyla kur (yeniden başlatır). phase!=='downloaded' → no-op. */
      install: () => ipcRenderer.invoke("update:install"),
      /** "Bu sürüm için sonra" — sürüm-bazlı kalıcı dismiss (settings.json). → durum. */
      dismiss: () => ipcRenderer.invoke("update:dismiss"),
      /** Main durum push'u (kontrol sonucu/dismiss) → rozet CANLI güncellenir. Returns unsubscribe. */
      onState: (cb) => {
        const l = (_e, s) => cb(s);
        ipcRenderer.on("update:state", l);
        return () => ipcRenderer.removeListener("update:state", l);
      }
    });
    contextBridge.exposeInMainWorld("announceApi", {
      /** → { checked, fromCache, lastCheckedAt, currentVersion, items:[{id,level,title,body,action,read,hidden,…}] }. */
      get: () => ipcRenderer.invoke("announce:get"),
      /** Feed'i şimdi çek (Ayarlar/geliştirici tetiği). → aynı durum nesnesi. */
      checkNow: () => ipcRenderer.invoke("announce:checkNow"),
      /** "Okudum" — KALICI (settings.json); bir daha şerit çıkmaz. → durum. */
      markRead: (id) => ipcRenderer.invoke("announce:markRead", id),
      /** Şeridin ✕'i — OTURUMLUK gizleme (diske yazılmaz, yeniden açılışta geri gelir). */
      hide: (id) => ipcRenderer.invoke("announce:hide", id),
      /** Aksiyon düğmesi: adresi MAIN çözer + https doğrular + shell.openExternal. */
      openAction: (id) => ipcRenderer.invoke("announce:openAction", id),
      /** Gövde içi link: main adresin O duyurunun gövdesinde GERÇEKTEN geçtiğini doğrular. */
      openLink: (id, url) => ipcRenderer.invoke("announce:openLink", id, url),
      /** Main durum push'u (yeni feed / okundu) → UI CANLI güncellenir. Returns unsubscribe. */
      onState: (cb) => {
        const l = (_e, s) => cb(s);
        ipcRenderer.on("announce:state", l);
        return () => ipcRenderer.removeListener("announce:state", l);
      }
    });
    contextBridge.exposeInMainWorld("changelogApi", {
      /** → { checked, fromCache, lastCheckedAt, recentCount, recentWindowDays, items:[{date,category,version,product,url,tr,en}] }. */
      get: () => ipcRenderer.invoke("changelog:get"),
      /** Feed'i şimdi çek (geliştirici tetiği). → aynı durum nesnesi. */
      checkNow: () => ipcRenderer.invoke("changelog:checkNow"),
      /** Sürüm notu linki: main renderer'ın gönderdiği adresi KENDİ kayıt listesiyle doğrular. */
      openUrl: (url) => ipcRenderer.invoke("changelog:openUrl", url),
      /** Main durum push'u (periyodik tazeleme) → UI CANLI güncellenir. Returns unsubscribe. */
      onState: (cb) => {
        const l = (_e, s) => cb(s);
        ipcRenderer.on("changelog:state", l);
        return () => ipcRenderer.removeListener("changelog:state", l);
      }
    });
    var authBridgeObj = {
      /** → { ok, signedIn, email, licenseStatus:'none'|'fresh'|'grace'|'expired'|'invalid', seat, products[], requireSeat }. */
      get: () => ipcRenderer.invoke("crewpane:get"),
      /** Sistem tarayıcısında PKCE girişini başlat → { ok, url }. */
      signIn: () => ipcRenderer.invoke("crewpane:signIn"),
      /**
       * Hesaptan çık (sunucuda revoke + yerel oturum & lisans jetonu silinir).
       *
       * ADP-863 — SEÇENEKLER ARTIK KABLODA TAŞINIR (eskiden hiç iletilmiyordu, bu yüzden
       * `force` yolu arayüzden ERİŞİLEMEZDİ → çalışan pane varken çıkış SESSİZCE reddedilirdi):
       *   `{ probe:true }` → çıkmadan "ne kapanacak" sayıları + onay metni
       *   `{ force:true }` → kullanıcı onay diyaloğunu onayladı, çalışan pane'lere rağmen çık
       */
      signOut: (opts) => ipcRenderer.invoke("crewpane:signOut", opts),
      /** Lisans jetonunu yeniden çek (ağ hatasında cached jeton KORUNUR — offline ≠ kilit). */
      refresh: () => ipcRenderer.invoke("crewpane:refresh"),
      /**
       * SEC-01 — hesaba bağlı cihazlar → { ok, devices:[…], currentDeviceId }.
       * `currentDeviceId` listede "bu cihaz"ı işaretlemek için: kullanıcı oturduğu
       * makineyi yanlışlıkla çıkarmasın.
       */
      devices: () => ipcRenderer.invoke("crewpane:devices"),
      /**
       * SEC-01 — cihazı hesaptan çıkar → { ok, device } | { ok:false, reason }.
       * Cihazdaki hiçbir veri silinmez; yalnız o kurulum yeni lisans jetonu alamaz.
       * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
       */
      revokeDevice: (deviceId) => ipcRenderer.invoke("crewpane:deviceRevoke", deviceId),
      /**
       * SEC-02 — DİĞER CİHAZLARI BIRAK → { ok, released } | { ok:false, reason }.
       * `revokeDevice`ten AYRI: koltuğu boşaltır, cihazı hesapta BIRAKIR. Uyuyan ya
       * da çöken bir makine kirasını bırakamadığında kullanıcının kaçış kapısıdır.
       * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
       */
      releaseOtherDevices: () => ipcRenderer.invoke("crewpane:deviceReleaseOthers"),
      /** ADP-646 — "Paket al": faturalandırma sayfasını SİSTEM TARAYICISINDA aç → { ok, url }. */
      openBilling: () => ipcRenderer.invoke("crewpane:openBilling"),
      /**
       * ADP-719 — giriş dönüşü (crewpane://) DOĞRU uygulamaya mı geliyor?
       * → { ok, severity:'blocking'|'warn'|null, ownsDefault, conflicts:[{path,bundleId,name}], reason }
       * `{ repair:true }` şema sahipliğini bu uygulamaya geri alır (kullanıcı tıkı).
       */
      schemeHealth: (opts) => ipcRenderer.invoke("crewpane:schemeHealth", opts),
      /**
       * LX-SAFESTORAGE-01 — bu makinede oturum SAKLANABİLİR Mİ?
       * → { ok, measured, available, backend, plaintext, canStore, reasonKey }
       * `canStore:false` ise giriş duvarı kullanıcıya SEBEBİNİ söyler (her açılışta
       * yeniden giriş isteneceğini). SIR TAŞIMAZ: yalnız arka ucun adı + hüküm.
       * `canStore:null` = ölçülemedi ("kapalı" DEĞİL — ADP-721).
       */
      secretBackend: () => ipcRenderer.invoke("crewpane:secretBackend"),
      /**
       * ADP-719 — İKİNCİ GİRİŞ YOLU: deep-link dönmediyse tarayıcının adres
       * çubuğundaki dönüş bağlantısı elle verilir; deep-link ile AYNI yoldan işlenir.
       */
      pasteCallback: (url) => ipcRenderer.invoke("crewpane:pasteCallback", url),
      /** Main durum değişince push eder (giriş/çıkış/jeton) → Ayarlar CANLI güncellenir. */
      onState: (cb) => {
        const l = (_e, s) => cb(s);
        ipcRenderer.on("crewpane:state", l);
        return () => ipcRenderer.removeListener("crewpane:state", l);
      },
      // ── RESET-03 — KURULUMU SIFIRLA ───────────────────────────────────────────
      //
      // 🔴 BEYAZ LİSTE KAPIDIR ([[ref_preload_whitelist_is_a_gate]]) — ve KAPININ
      // İKİ KATI VAR. İlk yazımda bu iki metot AYRI bir `window.resetApi` globaline
      // konmuştu: kanal adları doğruydu, main handler'ı vardı, kanal kapısı YEŞİLDİ
      // — ama RESET-02 köprüyü `window.crewpaneApi` ÜZERİNDE arıyor
      // (`resetFlow.resetApiFrom(crewpaneApi())`) ve bulamayınca "Gelişmiş" bölümünü
      // HİÇ ÇİZMİYOR. Yani özellik sessizce ölüyordu. Kanalın VAR olması yetmez;
      // KARŞI TARAFIN BAKTIĞI YERDE olması gerekir.
      //
      // KARAR BURADA VERİLMEZ. Onay sözcüğünü MAIN karşılaştırır (dil main'de
      // bilinir, renderer'a güvenilmez); bu köprü yalnız kullanıcının yazdığı metni
      // taşır. Yol/hedef alanları main'de DÜŞER (resetGate.sanitizeRequest).
      /**
       * KURU KOŞUM — hiçbir şey silinmez. `{ level }`
       * → { ok, level, bytesTotal:number|null, targets:[{kind,bytes,entries}],
       *     keeps:[{label}], warnings:[string], confirmWord, panes, terminals, agents }
       * `bytesTotal:null` = "hesaplanamadı" (0 DEĞİL).
       */
      resetPlan: (opts) => ipcRenderer.invoke("reset:plan", opts),
      /**
       * SIFIRLAMA İSTEĞİ — { level:'session'|'full', confirmText, keepLogs }.
       * → { ok:true, restarting:true } | { ok:false, reason:'bad_confirm'|'bad_level'|… }
       * Çalışan süreçte hiçbir kullanıcı dosyası silinmez: main işaretçi yazar ve
       * uygulama yeniden başlar; silme yeni sürecin EN BAŞINDA olur (Windows kilidi).
       */
      resetRequest: (req) => ipcRenderer.invoke("reset:request", req)
    };
    contextBridge.exposeInMainWorld("crewpaneApi", authBridgeObj);
    contextBridge.exposeInMainWorld("prefsApi", {
      /** Bu cihazın localStorage tercihlerini projeksiyona bildir. → { ok, changed, dropped } */
      publish: (values) => ipcRenderer.invoke("prefs:publish", { values }),
      /** Projeksiyondaki renderer tercihleri + beyaz liste. → { ok, values, keys, status } */
      pull: () => ipcRenderer.invoke("prefs:pull"),
      /** Ayarlar → Senkron satırının gerçeği. → { ok, exists, keyCount, lastApplied, file } */
      status: () => ipcRenderer.invoke("prefs:status"),
      /**
       * Uzak tercihler UYGULANDI. `applied` = settings.json'a yazılan anahtarlar;
       * renderer ekseni için `pull()` çağrılır (gövde sinyalle taşınmaz — ADP-712).
       */
      onChanged: (cb) => {
        const h = (_e, payload) => {
          try {
            cb(payload);
          } catch {
          }
        };
        ipcRenderer.on("prefs:changed", h);
        return () => ipcRenderer.removeListener("prefs:changed", h);
      }
    });
  }
});

// src/preload/bridges/sync.js
var require_sync = __commonJS({
  "src/preload/bridges/sync.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("integrationsApi", {
      /** → { ok, available, records:[{id,service,scope,env,authKind,envVar,meta}], catalog:[…] }. */
      list: () => ipcRenderer.invoke("integ:list"),
      /**
       * Yeni bağlantı: { service, secret, scope?, env?, keyLabel?, scopeHint?, userFields? }
       * → { ok, record } (record MASKELİ) | { ok:false, reason, error }.
       */
      add: (input) => ipcRenderer.invoke("integ:add", input),
      /** Bağlantıyı kes: cred_… → { ok, removed, restartHint } (açık pane'ler yeniden başlatılmalı). */
      remove: (id) => ipcRenderer.invoke("integ:remove", id),
      // ── MCP-COST-01 — MALIYET GORUNURLUGU + OTOMATIK ACILMA ISARETI ───────────
      // Ikisi de SIR TASIMAZ. `mcpStats` yalniz sayar (surec/RSS), `autostart`
      // yalniz bir sonraki pane acilisini etkiler — baglantiyi KOPARMAZ.
      /**
       * Su anki MCP maliyeti →
       * { ok, measured, paneCount, totalMb, services:{ <servis>:{panes,procs,wrappers,rssMb,orphans} } }
       * `measured:false` = `ps` okunamadi (UI sifir yazmamali, "olculemedi" demeli).
       */
      mcpStats: () => ipcRenderer.invoke("integ:mcpStats"),
      /**
       * Otomatik acilma isareti.
       *   ()                                        → { ok, map }
       *   ({ op:'set', service, enabled:false })     → { ok, map, restartHint }
       * Yazili olmayan servis ACIKTIR (varsayilan degismedi).
       */
      autostart: (payload) => ipcRenderer.invoke("integ:autostart", payload),
      /**
       * Gerçek MCP handshake ile dene: { service, env?, scope?, secret?, userFields? }
       * → { ok, tools, serverName, durationMs, reason?, error? }. `secret` verilirse
       * KAYDETMEDEN test edilir. `npx` paketi indirebileceği için uzun sürebilir.
       */
      test: (input) => ipcRenderer.invoke("integ:test", input),
      // ── INT-OBS-01 — TELEMETRİ OTOMATİK KURULUMU ──────────────────────────────
      // 🔴 Bu üç çağrının HİÇBİRİ jeton TAŞIMAZ — ne içeri ne dışarı. Jeton zaten
      // kasadadır; main onu kendi çözer. Renderer yalnız "hangi servis" der ve
      // maskeli bir SONUÇ alır. `add`ten farkı budur (o, sırrı bir kez içeri yollar).
      /**
       * Kurulumu çalıştır: { service:'sentry'|'posthog', orgSlug?, teamSlug? }
       * → { ok, org, channels, notes } | { ok:false, code:'choose-org', orgs:[…] }
       *   | { ok:false, code, message }  (message KULLANICI CÜMLESİDİR, hata kodu değil)
       */
      provision: (input) => ipcRenderer.invoke("telemetry:provision", input),
      /**
       * Doğrulama olayı gönder + panoda göründüğünü OKU:
       * → { ok, channel, sent, confirmed, method, message }.
       * `confirmed:false` "gönderildi ama göremedim" demektir — sahte yeşil YOK.
       */
      verifyTelemetry: (input) => ipcRenderer.invoke("telemetry:verify", input),
      /** Durum yüzeyi → { ok, channel, services:[{service, connected, org, channels:[{channel,project,masked}], lastVerify}] }. */
      provisionStatus: () => ipcRenderer.invoke("telemetry:provisionStatus")
    });
    contextBridge.exposeInMainWorld("syncApi", {
      /** Rozet + kuruluş görüntüsü. → { ok, enabled, state, queued, conflictsOpen, realtimeProven, plan, setup } */
      status: () => ipcRenderer.invoke("sync:status"),
      /** "Şimdi eşitle" — gerçek tur (jeton tazelenir, yedek tur yeniden planlanır). */
      now: (opts) => ipcRenderer.invoke("sync:now", opts || {}),
      /** Açık çakışmalar (GÖVDESİZ). → { ok, rows:[{id,relPath,class,kind,winnerSha,loserSha,recoverable,…}], count } */
      conflicts: (opts) => ipcRenderer.invoke("sync:conflicts", opts || {}),
      /** "Kaybedeni yanına yaz" — üzerine YAZMAZ, `<ad>.conflict-<8hex>.<uzantı>` açar. → { ok, path } */
      restoreLoser: (id) => ipcRenderer.invoke("sync:restoreLoser", { id }),
      /** Kullanıcı kararını deftere yaz: 'kept-winner' | 'restored-loser' | 'merged-manual'. */
      resolveConflict: (id, resolution) => ipcRenderer.invoke("sync:resolveConflict", { id, resolution }),
      /** §5.4 sır kapısı: "bu dosyada sır yok, yükle" (sha256 ile). */
      approveSecret: (sha256) => ipcRenderer.invoke("sync:approveSecret", { sha256 }),
      /** Yeniden girişten sonra DURMUŞ kuyruğu sürdür. */
      resumeQueue: () => ipcRenderer.invoke("sync:resumeQueue"),
      /** Tercih kaydedildikten sonra motoru yeniden çöz (kapatma ANINDA söker). */
      refresh: (opts) => ipcRenderer.invoke("sync:refresh", opts || {})
    });
    contextBridge.exposeInMainWorld("memoryApi", {
      /** → { nodes:[{slug,name,type,scope,desc}], edges:[{from,to}], counts, scopes }. */
      graph: () => ipcRenderer.invoke("memory:graph"),
      /** ADP-277 — one fact's full body: (scope, slug) → { slug, scope, name, description, type, body } | null. */
      fact: (scope, slug) => ipcRenderer.invoke("memory:fact", scope, slug),
      // ADP-870 (Faz 2) — hafıza RAG indeksi. İndeksleme AYRI SÜREÇTE koşar; buradaki
      // çağrılar yalnız onu başlatır/durdurur ve ilerlemesini dinler (UI donmaz).
      /** → { running, phase, startedAt, lastEvent, lastResult, reason, dbFile }. */
      indexStatus: () => ipcRenderer.invoke("memoryIndex:status"),
      /** Arka plan indekslemeyi başlat → { ok, dbFile } | { ok:false, reason }. */
      indexStart: () => ipcRenderer.invoke("memoryIndex:start"),
      /** Nazik durdur (dosya sınırında) → { ok } | { ok:false, reason:'not_running' }. */
      indexStop: () => ipcRenderer.invoke("memoryIndex:stop"),
      /**
       * İlerleme akışı. cb gets { phase, done?, total?, chunks?, file?, rssMb?, reason? }.
       * phase: scanned|planned|indexing|done|exit|stopped|unavailable|error. Returns unsubscribe.
       */
      onIndexEvent: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("memoryIndex:event", listener);
        return () => ipcRenderer.removeListener("memoryIndex:event", listener);
      },
      // ADP-871 (Faz 3) — hibrit arama (kelime + anlam). ADP-854'ün dosya-adı eşleşmesi
      // yerinde DURUYOR; bu onun yanına gelen ikinci bir yüzey.
      /**
       * → { ok:true, results:[{ name, docPath, headingPath, lineStart, lineEnd, excerpt,
       *     matchedBy:['anlam'|'kelime'], score }], text, degraded, sources }
       *   | { ok:false, reason:'index_not_built'|'empty_query'|… }
       * `degraded:true` = anlam katmanı bu sorguya katılamadı (model ısınıyor ya da kurulu
       * değil) → sonuçlar yalnız kelime katmanından. `text` doğrudan gösterilebilir; sonuç
       * yoksa "Hafızada bunu bulamadım." der (uydurma yok).
       */
      search: (query, k) => ipcRenderer.invoke("memoryIndex:search", query, k),
      /** → { embedderReady, embedderRunning, unavailable, semanticEnabled, openIndexes }. */
      searchStatus: () => ipcRenderer.invoke("memoryIndex:searchStatus"),
      // ── ADP-900 — ANLAM KATMANI: ONAYLI İNDİRME ───────────────────────────────
      // Kural: onay verilmeden TEK BAYT inmez ve kapı MAIN tarafındadır (renderer'a
      // güvenilmez). `embedPlan` yalnız BOYUT sorar (HEAD; gövde inmez, disk yazılmaz).
      /** → { ok, prefs:{semanticEnabled,autoIndex,consent}, available, reason, model, ramMb, diskBytes, install, search }. */
      embedState: () => ipcRenderer.invoke("memoryEmbed:state"),
      /** Sunucudan ÖLÇÜLEN plan → { ok, model:{files,totalBytes,…}, runtime, totalBytes, remainingBytes, ramMb, ready, consentKey }. */
      embedPlan: () => ipcRenderer.invoke("memoryEmbed:plan"),
      /** Kullanıcının kararını damgala (granted=false → kapalı kalır, hiçbir şey inmez). */
      embedConsent: (granted, key) => ipcRenderer.invoke("memoryEmbed:consent", granted, key),
      /** İndirmeyi başlat (damga plana uymuyorsa `consent_required` döner). */
      embedInstall: () => ipcRenderer.invoke("memoryEmbed:install"),
      /** İptal — yarım dosya KALIR, sonraki deneme kaldığı yerden sürer. */
      embedCancel: () => ipcRenderer.invoke("memoryEmbed:cancel"),
      /** Model + çalışma zamanını sil → { ok, freedBytes }. */
      embedRemove: () => ipcRenderer.invoke("memoryEmbed:remove"),
      /** { semanticEnabled?, autoIndex? } → { ok, prefs }. */
      embedSetPrefs: (patch) => ipcRenderer.invoke("memoryEmbed:setPrefs", patch),
      /** Kurulum ilerlemesi: { phase, file, receivedBytes, totalBytes, reason, message }. Aboneliği bırakır. */
      onEmbedEvent: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("memoryEmbed:event", listener);
        return () => ipcRenderer.removeListener("memoryEmbed:event", listener);
      },
      // ADP-862 (st1) — ÜRÜN UCU. `search`in ham çıktısının üstünde üç GARANTİ verir:
      // her sonuçta kaynak (dosya+satır) + alıntı · sonuç yoksa "Hafızada bunu
      // bulamadım." (uydurma yok) · gösterilen metin sır maskesinden geçmiş.
      /**
       * → { ok, found, query, results:[{ source, name, scope, heading, lineStart,
       *     lineEnd, excerpt, matchedBy, score }], text, degraded, masked, reason? }
       */
      recall: (query, k) => ipcRenderer.invoke("memory:recall", query, k)
    });
  }
});

// src/preload/bridges/browser.js
var require_browser = __commonJS({
  "src/preload/bridges/browser.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("browserControlBridge", {
      /** Subscribe to approval requests. cb gets { requestId, action, selector?, text?, agentId? }. */
      onApproval: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("browser:approval", l);
        return () => ipcRenderer.removeListener("browser:approval", l);
      },
      /**
       * Reply to an approval request: { requestId, approved, scope? }.
       * ADP-341 — `scope:'session'` = "bu görev boyunca izin ver" (yalnız kapı `scope:'session'`
       * teklif ettiyse geçerlidir; TTL 30dk + eylem tavanı, diske YAZILMAZ). Yoksa tek eylemlik.
       */
      approvalResult: (res) => ipcRenderer.send("browser:approval:result", res),
      /**
       * ADP-341 (ADR-026 §3.3) — DURDUR: tüm görev-başı izinleri iptal eder ve bekleyen onay
       * varsa onu da geçersiz kılar. → { revoked, epoch }
       */
      stop: () => ipcRenderer.invoke("browser:stop"),
      /**
       * ADP-343 (ADR-026 §2.5) — OTOMASYON MODU: süre sınırlı "bu oturumda sorma" (Ayarlar → Güven).
       * `minutes` null/0 → kapat. Oturumluk: diske yazılmaz, DURDUR kapatır, hassas hedef ve yasak
       * origin bundan ETKİLENMEZ. → { active, until, remainingMs, minutes:[…] }
       */
      setAutomation: (minutes) => ipcRenderer.invoke("browser:trust:automation", { minutes }),
      /** ADP-343 — otomasyon modunun canlı durumu (geri sayım). */
      automationStatus: () => ipcRenderer.invoke("browser:trust:status"),
      /** Subscribe to the agent's browser activity feed. cb gets { action, selector?, agentId?, at }. */
      onActivity: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("browser:activity", l);
        return () => ipcRenderer.removeListener("browser:activity", l);
      },
      /**
       * ADP-135 — run a browser action (navigate/click/type/read/readPage/screenshot/
       * back) against the live internal-browser guest. Used by Jarvis voice
       * (jarvisVoice.executeBrowser). Resolves { ok, result? } | { ok:false, error }.
       */
      run: (value) => ipcRenderer.invoke("browser:action", value),
      /**
       * ADP-150 (multi-tab) — main asks the renderer to open a new IN-APP browser tab
       * when a guest does target=_blank / window.open (instead of the OS browser). cb
       * gets { url }. Returns an unsubscribe fn.
       */
      onNewTab: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("browser:new-tab", l);
        return () => ipcRenderer.removeListener("browser:new-tab", l);
      },
      /**
       * ADP-150 (multi-tab) — tell main which <webview> guest (by webContents id) is the
       * active tab, so headed automation (ADP-095) drives the visible tab. Main only
       * accepts an id it tracked at attach time (never the app renderer).
       */
      setActiveGuest: (id) => ipcRenderer.send("browser:setActiveGuest", id),
      /**
       * ADP-333 — main, bir AJANA ait sekme açılmasını ister (ajan kendi sekmesine kilitli;
       * kullanıcının sekmesine asla girmez). cb { agentId, url } alır. Sekme ARKA PLANDA
       * açılır: patronun baktığı sayfa değişmez.
       */
      onAgentTab: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("browser:agent-tab", l);
        return () => ipcRenderer.removeListener("browser:agent-tab", l);
      },
      /** ADP-333 — bu sekmenin SAHİBİ şu ajan: { guestId, agentId }. */
      setTabOwner: (payload) => ipcRenderer.send("browser:setTabOwner", payload),
      /**
       * ADP-394 — HAYALET MOD: main, bir guest'in KOMPOZE EDİLMESİNİ ister (otomasyon koşarken).
       * cb { guestId, on } alır. `display:none` bir <webview> kare üretmez → tıklama inmez
       * (ADP-392). Renderer o sekmeyi görünmez ama çizilen bir katmana çevirir; boşta kapatır.
       */
      onComposite: (cb) => {
        const l = (_e, p) => cb(p);
        ipcRenderer.on("browser:composite", l);
        return () => ipcRenderer.removeListener("browser:composite", l);
      }
    });
  }
});

// src/preload/bridges/system.js
var require_system = __commonJS({
  "src/preload/bridges/system.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    contextBridge.exposeInMainWorld("popoutApi", {
      /** Pane'i ayrı pencereye çıkar. `{ paneId, title?, agentId? }` → { ok, paneId } | { ok:false, error }. */
      open: (payload) => ipcRenderer.invoke("popout:open", payload),
      /** Pop-out penceresini kapat = pane eski hücresine döner. → { ok } | { ok:false, error }. */
      close: (paneId) => ipcRenderer.invoke("popout:close", paneId),
      /** Şu an dışarıda olan paneId'ler (reload sonrası durum hidrasyonu). → string[]. */
      list: () => ipcRenderer.invoke("popout:list"),
      /** Pop-out penceresi kapandı (kullanıcı ⌘W/kırmızı düğme/"Geri koy"). cb gets { paneId }. Returns unsubscribe. */
      onClosed: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("popout:closed", listener);
        return () => ipcRenderer.removeListener("popout:closed", listener);
      },
      /** ADP-712 — pencereyi büyüt/eski boyutuna getir (ızgaradaki "zoom"un karşılığı). */
      toggleMaximize: (paneId) => ipcRenderer.invoke("popout:toggleMaximize", paneId),
      /** ADP-712 — pencerenin şu anki durumu → { paneId, maximized } | null. */
      state: (paneId) => ipcRenderer.invoke("popout:state", paneId),
      /** ADP-712 — pencere native düğmeyle büyütüldü/küçültüldü. cb gets { paneId, maximized }. */
      onState: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on("popout:state", listener);
        return () => ipcRenderer.removeListener("popout:state", listener);
      }
    });
    contextBridge.exposeInMainWorld("feedbackApi", {
      /** → { ok, text, lines } | { ok:false, reason:'no-log'|'unreadable' } */
      logExcerpt: (opts) => ipcRenderer.invoke("feedback:logExcerpt", opts || {}),
      /** → { ok, shots:[{name, at, bytes, thumbDataUrl}] } | { ok:false, reason:'no-dir' } */
      recentShots: (opts) => ipcRenderer.invoke("feedback:recentShots", opts || {}),
      /** → { ok, name, dataUrl, sha256, width, height } | { ok:false, reason } */
      shotPreview: (opts) => ipcRenderer.invoke("feedback:shotPreview", opts || {})
    });
    contextBridge.exposeInMainWorld("localSpriteApi", {
      /** → { ok, dir, sprites:[{key,url48,url16,bytes}] } */
      list: () => ipcRenderer.invoke("sprites:listLocal"),
      /**
       * AVATAR-PACK-01 — Yüklü PAKETLER (manifest + lisans + karakterler + eksikler).
       * `list` ile aynı diski okur ama başka soruyu yanıtlar: `list` "hangi sprite
       * anahtarları çizilebilir", bu ise "hangi paket kurulu ve neyi vaat ediyor".
       * → { ok, dir, packages:[{key,manifest,characters,missing}], skipped }
       */
      listPackages: () => ipcRenderer.invoke("sprites:listPackages"),
      /** ADP-737 — Paket yükle (zip dosyası). → { ok, key?, manifest?, warnings?, error? } */
      installPackage: (zipPath) => ipcRenderer.invoke("sprites:installPackage", zipPath),
      /** ADP-737 — Paketi kaldır (key). → { ok, error? } */
      removePackage: (key) => ipcRenderer.invoke("sprites:removePackage", key),
      /** ADP-737 — Paketi dışa aktar (karakterleri zip'le). → { ok, path?, error? } */
      exportPackage: (keys) => ipcRenderer.invoke("sprites:exportPackage", keys)
    });
    contextBridge.exposeInMainWorld("feedbackSeenApi", {
      get: () => ipcRenderer.sendSync("feedback:seen:get"),
      set: (state) => ipcRenderer.invoke("feedback:seen:set", state)
    });
    contextBridge.exposeInMainWorld("resourceApi", {
      /** → { ok, state } — state: { level, freePct, reasons, waiting[], settings, … }. */
      state: () => ipcRenderer.invoke("resource:state"),
      /** "Yine de aç": kullanıcı HER ZAMAN açabilir. Onay süre-kutulu (ms; boş → varsayılan). */
      allowAnyway: (ms) => ipcRenderer.invoke("resource:allowAnyway", ms),
      /** Ayarlar: { enabled?, warnFreePct?, criticalFreePct? } → { ok, state }. Diske yazılır. */
      configure: (patch) => ipcRenderer.invoke("resource:configure", patch),
      /** Bitmiş (terminal + >15 dk sessiz) pane'ler. `department` verilirse yalnız o takım. */
      finishedPanes: (opts) => ipcRenderer.invoke("resource:finishedPanes", opts || {}),
      /** ONAYLI kapatma — main her paneId'yi yeniden ölçer (canlanan pane öldürülmez). */
      closeFinished: (paneIds) => ipcRenderer.invoke("resource:closeFinished", { paneIds }),
      /** Baskı seviyesi ya da bekleme kuyruğu değişince push. Dönen fonksiyon aboneliği bırakır. */
      onPressure: (cb) => {
        const l = (_e, state) => cb(state);
        ipcRenderer.on("resource:pressure", l);
        return () => ipcRenderer.removeListener("resource:pressure", l);
      }
    });
    contextBridge.exposeInMainWorld("reportsApi", {
      /** cb: ({ at }) => void — abonelikten çıkmak için dönen fonksiyonu çağır. */
      onChanged: (cb) => {
        const l = (_e, payload) => cb(payload || { at: Date.now() });
        ipcRenderer.on("reports:changed", l);
        return () => ipcRenderer.removeListener("reports:changed", l);
      }
    });
  }
});

// src/preload/bridges/test.js
var require_test = __commonJS({
  "src/preload/bridges/test.js"() {
    "use strict";
    var { contextBridge, ipcRenderer } = require("electron");
    if (process.env.CREWPANE_AUTOTEST || process.env.NODE_ENV === "test") {
      contextBridge.exposeInMainWorld("spikeProbe", {
        rendered: (chunk) => ipcRenderer.send("spike:rendered", chunk),
        done: (summary) => ipcRenderer.send("spike:done", summary)
      });
    }
  }
});

// src/preload/index.js
require_platform();
require_database();
require_core();
require_terminal();
require_agents();
require_skills();
require_tasks();
require_voice();
require_files();
require_services();
require_hand();
require_mobile();
require_settings();
require_sync();
require_browser();
require_system();
require_test();
