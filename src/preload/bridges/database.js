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
