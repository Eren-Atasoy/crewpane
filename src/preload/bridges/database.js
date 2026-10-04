'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const SUPABASE_DB_FLAG = '--crewpane-db=';
function decodeSupabaseDbTarget(argv) {
  const hit = (argv || []).find((a) => typeof a === 'string' && a.startsWith(SUPABASE_DB_FLAG));
  if (!hit) return null;
  try {
    // ⚠️ `atob` İKİLİ bir dize döndürür (her karakter BİR BAYT). Kodlama tarafı
    // `Buffer.from(json, 'utf8').toString('base64')`dir, yani ASCII dışı her karakter
    // ÇOK BAYTLIDIR → doğrudan JSON.parse edilirse mojibake olur ("İKİ" → "Ä°KÄ°").
    // Bugüne kadar fark edilmedi çünkü kablodaki her alan (URL, şema, kanal) ASCII'ydi;
    // ENV-02'de Türkçe bir alan geçirilmeye çalışılınca ÖLÇÜLDÜ. Bayt dizisine
    // çevirip TextDecoder ile çözmek doğru okumadır (TextDecoder sandbox'ta vardır).
    const bin = atob(hit.slice(SUPABASE_DB_FLAG.length));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const t = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    return t && t.url ? t : null;
  } catch {
    return null;
  }
}

const supabaseDbTarget = decodeSupabaseDbTarget(process.argv);
if (supabaseDbTarget) {
  const dbBridgeObject = {
    url: supabaseDbTarget.url,
    anonKey: supabaseDbTarget.anonKey,
    // ADP-621 — hangi SCHEMA: bulut crewpane-id'de uygulama tabloları `app` altında
    // (`public` = üyelik/fatura), yerel + e2e stack'lerde `public`te. Bu alan kabloda
    // düşerse renderer bulutta yanlış schema'yı sorgular ve HER sorgu 404 döner.
    schema: supabaseDbTarget.schema || undefined,
    // ADP-622 — KİMLİK: 'crewpane-id' ise app DB, jetonu imzalayan projeyle AYNI
    // projedir (ADP-621 kararı) → istemci her isteğe kullanıcının access token'ını
    // takar ve `auth.uid()` app schema'sında çözülür. Alan yoksa/başka değerse
    // istemci bugünkü gibi ANON key ile kurulur (yerel 54321, e2e 55321).
    auth: supabaseDbTarget.auth === 'crewpane-id' ? 'crewpane-id' : undefined,
    // Jetonu main ÜRETİR (safeStorage'daki oturumdan, süresi dolmuşsa SESSİZ
    // yenileyerek). Renderer jetonu saklamaz — her ihtiyaçta buradan ister; bu
    // yüzden `auth` kanalı bir DEĞER değil bir FONKSİYONDUR (bayat jeton olmasın).
    getAccessToken: () => ipcRenderer.invoke('appdb:token'),
    isE2E: !!supabaseDbTarget.isE2E,
    // ADP-723 — kanal rozeti (DataSourceBadge): "hangi kopya + hangi veri kaynağı"
    // ekranda görünsün. Alan yoksa (eski shell) rozet sessizce gizlenir.
    channel: typeof supabaseDbTarget.channel === 'string' ? supabaseDbTarget.channel : undefined,
    customerBuild: supabaseDbTarget.customerBuild === true ? true : undefined,
    // ENV-01 Faz 3 — KARIŞIM KARARI (yalnız `warn` seviyesinde gelir). Rozet bunu
    // ÜRETMEZ, okur. ⛔ BU BEYAZ LİSTE BİR KAPIDIR: main tarafında alanı eklemek
    // YETMEZ, buraya yazılmayan alan renderer'a HİÇ ULAŞMAZ ve rozet sessizce
    // görünmez kalır (ENV-02 Faz 3'te ölçüldü: main `env`i geçiriyordu, preload
    // düşürüyordu, `window.crewpaneDb.env` undefined'dı).
    // ⛔ `message` BİLEREK GEÇMİYOR: o metin ana sürecin TÜRKÇE log cümlesidir ve
    // arayüzde kullanılırsa İngilizce oturumda Türkçe bir uyarı çıkar. Rozet METNİ
    // sözlükten (`env.badge.mixed*`) üretir; kabloda yalnız MAKİNE JETONU gider.
    mixed: supabaseDbTarget.mixed && typeof supabaseDbTarget.mixed === 'object'
      ? { reason: supabaseDbTarget.mixed.reason }
      : undefined,
    // ENV-02 — DÖRT KATMAN (profil · şema · app DB · kimlik · giriş · posta).
    // Alanlar TEK TEK kopyalanır (ham nesne geçirilmez): kabloya ileride bir sır
    // eklenirse rozet onu kendiliğinden ekrana taşımasın. Anon anahtar burada YOK.
    env: supabaseDbTarget.env && typeof supabaseDbTarget.env === 'object'
      ? {
        profile: supabaseDbTarget.env.profile || undefined,
        scheme: supabaseDbTarget.env.scheme || undefined,
        dbUrl: supabaseDbTarget.env.dbUrl || undefined,
        dbSchema: supabaseDbTarget.env.dbSchema || undefined,
        authUrl: supabaseDbTarget.env.authUrl || undefined,
        loginUrl: supabaseDbTarget.env.loginUrl || undefined,
        mailUrl: supabaseDbTarget.env.mailUrl || undefined,
      }
      : undefined,
  };
  contextBridge.exposeInMainWorld('crewpaneDb', dbBridgeObject);
}


// ADP-625 — SİSTEM DURUMU: ilk açılış doktorunun raporu (Ayarlar → Sistem Durumu).
// Salt-okunur teşhis; hiçbir sır geçmez (rapor e-posta/anahtar taşımaz, ham hata
// metni yalnız destek alanı `raw`da kalır ve UI onu göstermez).
const doctorBridgeObj = {
  /** → { generatedAt, overall:'ok'|'warn'|'fail', checks:[{id,label,status,detail,…}] } */
  run: () => ipcRenderer.invoke('doctor:run'),
  /**
   * ADP-907 — yabancı kancanın yazılı olduğu AYAR DOSYASINI kullanıcının editöründe aç.
   * Yalnız AÇAR: uygulama o dosyaya ASLA yazmaz. Gönderilen yol main'de doktorun kendi
   * aday listesiyle doğrulanır (listede yoksa açılmaz) → rastgele dosya açtırılamaz.
   * → { ok:true, via:'editor'|'folder' } | { ok:false, reason }
   */
  openHookSettings: (filePath) => ipcRenderer.invoke('doctor:openHookSettings', filePath),
};
contextBridge.exposeInMainWorld('crewpaneDoctor', doctorBridgeObj);


// ADP-390 (ADR-027 / G9) — CrewPane hesabı köprüsü (Ayarlar → Hesap).
// Bu köprüden SIR GEÇMEZ: access/refresh token ve lisans jetonu MAIN'de (safeStorage)
// kalır; renderer yalnız DURUMU görür (e-posta, lisans, seat, aktif ürünler). Giriş
// sistem tarayıcısında açılır — uygulama içinde gömülü login webview'i YASAK (RFC 8252).
const authBridgeObj = {
  /** → { ok, signedIn, email, licenseStatus:'none'|'fresh'|'grace'|'expired'|'invalid', seat, products[], requireSeat }. */
  get: () => ipcRenderer.invoke('crewpane:get'),
  /** Sistem tarayıcısında PKCE girişini başlat → { ok, url }. */
  signIn: () => ipcRenderer.invoke('crewpane:signIn'),
  /**
   * Hesaptan çık (sunucuda revoke + yerel oturum & lisans jetonu silinir).
   *
   * ADP-863 — SEÇENEKLER ARTIK KABLODA TAŞINIR (eskiden hiç iletilmiyordu, bu yüzden
   * `force` yolu arayüzden ERİŞİLEMEZDİ → çalışan pane varken çıkış SESSİZCE reddedilirdi):
   *   `{ probe:true }` → çıkmadan "ne kapanacak" sayıları + onay metni
   *   `{ force:true }` → kullanıcı onay diyaloğunu onayladı, çalışan pane'lere rağmen çık
   */
  signOut: (opts) => ipcRenderer.invoke('crewpane:signOut', opts),
  /** Lisans jetonunu yeniden çek (ağ hatasında cached jeton KORUNUR — offline ≠ kilit). */
  refresh: () => ipcRenderer.invoke('crewpane:refresh'),
  /**
   * SEC-01 — hesaba bağlı cihazlar → { ok, devices:[…], currentDeviceId }.
   * `currentDeviceId` listede "bu cihaz"ı işaretlemek için: kullanıcı oturduğu
   * makineyi yanlışlıkla çıkarmasın.
   */
  devices: () => ipcRenderer.invoke('crewpane:devices'),
  /**
   * SEC-01 — cihazı hesaptan çıkar → { ok, device } | { ok:false, reason }.
   * Cihazdaki hiçbir veri silinmez; yalnız o kurulum yeni lisans jetonu alamaz.
   * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
   */
  revokeDevice: (deviceId) => ipcRenderer.invoke('crewpane:deviceRevoke', deviceId),
  /**
   * SEC-02 — DİĞER CİHAZLARI BIRAK → { ok, released } | { ok:false, reason }.
   * `revokeDevice`ten AYRI: koltuğu boşaltır, cihazı hesapta BIRAKIR. Uyuyan ya
   * da çöken bir makine kirasını bırakamadığında kullanıcının kaçış kapısıdır.
   * Başarıda main lisansı kendiliğinden tazeler (ret çözüldüyse hemen düşsün).
   */
  releaseOtherDevices: () => ipcRenderer.invoke('crewpane:deviceReleaseOthers'),
  /** ADP-646 — "Paket al": faturalandırma sayfasını SİSTEM TARAYICISINDA aç → { ok, url }. */
  openBilling: () => ipcRenderer.invoke('crewpane:openBilling'),
  /**
   * ADP-719 — giriş dönüşü (crewpane://) DOĞRU uygulamaya mı geliyor?
   * → { ok, severity:'blocking'|'warn'|null, ownsDefault, conflicts:[{path,bundleId,name}], reason }
   * `{ repair:true }` şema sahipliğini bu uygulamaya geri alır (kullanıcı tıkı).
   */
  schemeHealth: (opts) => ipcRenderer.invoke('crewpane:schemeHealth', opts),
  /**
   * LX-SAFESTORAGE-01 — bu makinede oturum SAKLANABİLİR Mİ?
   * → { ok, measured, available, backend, plaintext, canStore, reasonKey }
   * `canStore:false` ise giriş duvarı kullanıcıya SEBEBİNİ söyler (her açılışta
   * yeniden giriş isteneceğini). SIR TAŞIMAZ: yalnız arka ucun adı + hüküm.
   * `canStore:null` = ölçülemedi ("kapalı" DEĞİL — ADP-721).
   */
  secretBackend: () => ipcRenderer.invoke('crewpane:secretBackend'),
  /**
   * ADP-719 — İKİNCİ GİRİŞ YOLU: deep-link dönmediyse tarayıcının adres
   * çubuğundaki dönüş bağlantısı elle verilir; deep-link ile AYNI yoldan işlenir.
   */
  pasteCallback: (url) => ipcRenderer.invoke('crewpane:pasteCallback', url),
  /** Main durum değişince push eder (giriş/çıkış/jeton) → Ayarlar CANLI güncellenir. */
  onState: (cb) => {
    const l = (_e, s) => cb(s);
    ipcRenderer.on('crewpane:state', l);
    return () => ipcRenderer.removeListener('crewpane:state', l);
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
  resetPlan: (opts) => ipcRenderer.invoke('reset:plan', opts),
  /**
   * SIFIRLAMA İSTEĞİ — { level:'session'|'full', confirmText, keepLogs }.
   * → { ok:true, restarting:true } | { ok:false, reason:'bad_confirm'|'bad_level'|… }
   * Çalışan süreçte hiçbir kullanıcı dosyası silinmez: main işaretçi yazar ve
   * uygulama yeniden başlar; silme yeni sürecin EN BAŞINDA olur (Windows kilidi).
   */
  resetRequest: (req) => ipcRenderer.invoke('reset:request', req),
};
contextBridge.exposeInMainWorld('crewpaneApi', authBridgeObj);
