// ADP-586 (Entegrasyon Merkezi / Dalga 0) — SIR MASKELEME (Kural 4'ün son halkası).
//
// ADP-585 anahtarı pane'in env'ine koyuyor (bilinçli, ölçülmüş risk: "pane-içi
// görünürlük"). Oradan sonra sır ÜÇ yolla dışarı sızabilir ve üçü de KALICI iz bırakır:
//   1. ekran/pane tamponu — ajan `env` basar, MCP server hata mesajında jetonu echo'lar;
//   2. main log'u (crewpane-shell.log) — spawn satırı, hata mesajı;
//   3. notify dosyası (docs/.agent-notifications) — worker DONE/FAIL detayı.
// Şifreli vault'un tek amacı sırrın diske DÜZ yazılmaması; log'a düşen bir jeton o
// güvenceyi tamamen boşa çıkarır (log dosyaları paylaşılır, ekran görüntüsü alınır,
// notify dosyası repo'ya commit'lenir).
//
// TASARIM — neden "kayıtlı değer araması", neden regex değil:
//   • Kaynak-taraflı maskeleme (her log çağrısına elle mask eklemek) EKSİK kalır:
//     sırrı basan yer bizim kodumuz değil, ajanın kendi çıktısı. Bu yüzden maskeleme
//     ÇIKIŞ noktasında, bilinen DEĞERLERİN literal aranmasıyla yapılır.
//   • Desen (regex "sk-[A-Za-z0-9]{20,}") yolu KASITLI seçilmedi: hem yanlış-pozitif
//     (rastgele hash'i maskeler) hem yanlış-negatif (Hostinger/Coolify jetonlarının
//     ayırt edici ön eki yok) üretir. Bildiğimiz değeri ararız — bilmediğimizi değil.
//   • `split/join` (literal) kullanılır, `RegExp` DEĞİL: sır içindeki `.`/`(`/`+`
//     karakterleri desen olarak yorumlanmaz ve ReDoS yüzeyi oluşmaz.
//
// SICAK YOL: `redact()` kayıt boşken (entegrasyonu olmayan kullanıcı = bugünün
// varsayılanı) girdiyi AYNEN döndürür — pty onData akışına ölçülebilir yük binmez.
//
// BELLEK DURUŞU: kayıt defteri düz-metin sırrı main sürecinin BELLEĞİNDE tutar. Bu
// yeni bir maruziyet DEĞİL (aynı değer zaten pane env'inde ve spawn planında duruyor);
// buna karşılık defter dışarıya hiç açılmaz — modül yalnız `redact()` verir, sırrı
// okutan bir API (list/get) BİLEREK yoktur.
//
// Saf + DI: electron/fs bağı YOK → `node --test` ile koşar.

'use strict';

// Bu uzunluğun ALTINDAKİ değer kaydedilmez. Gerekçe: 8 karakterden kısa bir dizi
// sıradan metinde de geçer ("test1234") → log'un yarısını maskeleyip okunamaz hale
// getirirdi. Gerçek servis jetonları çok daha uzundur; kısa bir "anahtar" zaten
// dar-yetkili anahtar rehberliğine (Kural 3) uymayan bir girdidir.
const MIN_SECRET_LENGTH = 8;

// Defter tavanı — bozuk bir çağıran döngüde register ederse bellek/CPU patlamasın.
const MAX_SECRETS = 128;

/** Varsayılan maske (katalog profili verilmediğinde) — değerden hiçbir şey sızdırmaz. */
function defaultMask() {
  return '••••';
}

/**
 * INT-0-E — KALIP TABANLI DSN REDAKSİYONU (defterden BAĞIMSIZ).
 *
 * Defter yalnız KAYITLI sırları maskeler; oysa bir bağlantı dizesi transkripte
 * kasa'dan geçmeden de düşer: ajan `psql` çıktısını yapıştırır, bir hata mesajı
 * DSN'i yankılar, kullanıcı sohbete elle yazar. Kayıtlı olmadığı için defter onu
 * GÖRMEZ ve parola log'a/rapora/pane geçmişine düşer.
 *
 * Kalıp DAR tutuldu — yalnız `<şema>://<kullanıcı>:<parola>@` bölgesindeki PAROLA
 * değiştirilir. Host/yol/query'ye DOKUNULMAZ: geniş bir kalıp sıradan URL'leri de
 * bozar ve maskeleme "metni okunmaz kılma"ya döner (o da bir kusurdur, sessiz
 * olanı). Parolası olmayan `https://site.com/a` gibi URL'ler kalıba UYMAZ.
 *
 * SICAK YOL: önce ucuz bir `includes('://')` kapısı — kalıp yoksa regex hiç koşmaz
 * ve girdi AYNEN döner (referans eşitliği korunur).
 */
const DSN_CREDENTIALS_RE = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/:@]*)(:)([^\s/@]+)@/g;

function redactDsnCredentials(text) {
  if (typeof text !== 'string' || !text.includes('://')) return text;
  return text.replace(DSN_CREDENTIALS_RE, (m, scheme, user, colon, pw) => (
    pw === '••••' ? m : `${scheme}${user}${colon}••••@`
  ));
}

/**
 * @param {object} opts
 * @param {(secret:string, service?:string)=>string} [opts.mask] - integrationCatalog.maskSecret
 * @param {(line:string)=>void} [opts.log]
 */
function createSecretRedactor(opts = {}) {
  const mask = typeof opts.mask === 'function' ? opts.mask : defaultMask;
  const log = opts.log || (() => {});
  /** @type {Map<string,string>} secret → maskeli gösterim */
  const entries = new Map();
  /** Uzun→kısa sıralı sır listesi; uzun olan ÖNCE değişsin ki kısa bir sır uzun bir
   *  sırrın içinde eşleşip maskeyi parçalamasın. */
  let ordered = [];

  function reindex() {
    ordered = [...entries.keys()].sort((a, b) => b.length - a.length);
  }

  /**
   * Bir sırrı maskeleme defterine al.
   * @returns {boolean} kaydedildi mi (kısa/boş/dolu defter → false)
   */
  function register(secret, service) {
    if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return false;
    if (entries.has(secret)) return true;
    if (entries.size >= MAX_SECRETS) {
      log('secretRedactor: defter dolu — yeni sır maskeleme kapsamına ALINMADI');
      return false;
    }
    let masked;
    try {
      masked = mask(secret, service) || defaultMask();
    } catch {
      masked = defaultMask();
    }
    // Maske sırrı İÇERİYORSA (bozuk mask fonksiyonu) onu kullanmak sızıntının ta
    // kendisi olurdu → tam maskeye düş.
    if (masked.includes(secret)) masked = defaultMask();
    entries.set(secret, masked);
    reindex();
    return true;
  }

  /**
   * Bir spawn'ın env'inden çözümlenmiş entegrasyon sırlarını topla. Kaynak:
   * agentRunner.withIntegrations `childEnv[CREWPANE_SECRET_<id>]` yazar → uygulamada
   * sır enjekte edilen HER pane buradan geçer, ayrıca çağrı yerine gerek kalmaz.
   * @param {Record<string,string>} env
   * @param {string} [prefix]
   * @returns {number} kaydedilen yeni sır sayısı
   */
  function registerEnv(env, prefix = 'CREWPANE_SECRET_') {
    if (!env || typeof env !== 'object') return 0;
    let n = 0;
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith(prefix) && register(v)) n += 1;
    }
    return n;
  }

  /**
   * Metindeki bilinen sırları maskeyle değiştir. Sır yoksa girdi AYNEN döner
   * (referans eşitliği korunur — sıcak yol).
   */
  function redact(text) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const secret of ordered) {
      if (out.includes(secret)) out = out.split(secret).join(entries.get(secret));
    }
    return redactDsnCredentials(out);
  }

  /** Defterdeki en uzun sırrın uzunluğu (akış birleştirme penceresi için). */
  function maxLength() {
    return ordered.length ? ordered[0].length : 0;
  }

  /**
   * AKIŞ (pty) TAMPONU için kuyruk maskesi. Sorun: sır iki chunk'a bölünürse
   * chunk-başına maskeleme onu YAKALAYAMAZ — ama chunk'lar BİRİKTİĞİ tamponda
   * (pane replay, delegasyon anlık görüntüsü, mobil son-satır) sır BÜTÜN hâlde
   * durur. Bu yüzden tamponun yalnız SONU (yeni gelen `tailLen` + en uzun sır
   * kadar geriye taşma penceresi) yeniden taranır — tüm tamponu her chunk'ta
   * taramak O(tampon) maliyet demek olurdu.
   * @param {string} text - birikmiş tampon
   * @param {number} tailLen - bu turda eklenen bayt sayısı
   */
  function redactTail(text, tailLen) {
    if (!ordered.length || typeof text !== 'string' || !text) return text;
    const window = Math.max(0, tailLen | 0) + maxLength();
    if (text.length <= window) return redact(text);
    const cut = text.length - window;
    return text.slice(0, cut) + redact(text.slice(cut));
  }

  /**
   * Nesne/dizi içindeki TÜM string'leri maskele (IPC dönüşü, notify olayı gibi
   * yapılandırılmış yükler için). Döngüsel referans korunur (WeakSet), Buffer gibi
   * tipler olduğu gibi bırakılır.
   */
  function redactDeep(value, seen = new WeakSet()) {
    if (!ordered.length) return value;
    if (typeof value === 'string') return redact(value);
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return value;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, seen));
    if (Buffer.isBuffer(value)) return value;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, seen);
    return out;
  }

  return {
    register,
    registerEnv,
    redact,
    redactDsnCredentials, // INT-0-E — kalıp tabanlı DSN parolası (defterden bağımsız)
    redactTail,
    redactDeep,
    maxLength,
    /** Defterdeki sır sayısı (DEĞERLER dışarı verilmez — yalnız sayaç). */
    size: () => entries.size,
    /** Test/kapanış temizliği. */
    clear() {
      entries.clear();
      ordered = [];
    },
  };
}

const defaultInstance = createSecretRedactor();

module.exports = {
  createSecretRedactor,
  MIN_SECRET_LENGTH,
  MAX_SECRETS,
  register: (...args) => defaultInstance.register(...args),
  registerEnv: (...args) => defaultInstance.registerEnv(...args),
  redact: (...args) => defaultInstance.redact(...args),
  redactDsnCredentials: (...args) => defaultInstance.redactDsnCredentials(...args),
  redactTail: (...args) => defaultInstance.redactTail(...args),
  redactDeep: (...args) => defaultInstance.redactDeep(...args),
  maxLength: defaultInstance.maxLength,
  size: () => defaultInstance.size(),
  clear: () => defaultInstance.clear(),
  defaultInstance,
};
