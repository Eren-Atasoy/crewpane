// CrewPane — ADP-862 (st1) HAFIZA SONUCU SIR MASKELEME.
//
// NEDEN AYRI BİR MODÜL (secretRedactor.cjs DURURKEN):
//   `secretRedactor` BİLDİĞİMİZ değerleri maskeler — entegrasyon vault'una kayıtlı
//   jetonları. O tasarım log/pty akışı için DOĞRU ve burada da KORUNUR (main, arama
//   sonucunu ondan da geçirir). Ama hafıza aramasının tehdidi farklı: hafıza
//   dosyalarını AJANLAR yazar ve oraya vault'un HİÇ görmediği bir jeton düşebilir
//   (ekip hafızası: kaldırılmış bir entegrasyonun 46 karakterlik bot jetonu 2 gün
//   boyunca kullanıcının diskinde uyudu — vault onu hiç görmemişti).
//   Kayıtlı-değer araması onu göremez → arama sonucunda ekrana/sese aynen gider.
//
// BU YÜZDEN BURADA DESEN KULLANILIR — ve deseni seçerken iki yanlış eşit maliyetli
// DEĞİLDİR: bir jetonu göstermek KALICI bir sızıntıdır, sıradan bir dizeyi maskelemek
// yalnız okunurluk kaybıdır. Yine de gürültü üretmemek için iki sınıfla sınırlıyız:
//
//   A) KENDİNİ TANITAN ön ekler (sk-ant-…, ghp_…, eyJ….….…, AKIA…, xoxb-…):
//      bu biçimler sıradan metinde geçmez → bağlam aranmadan maskelenir.
//   B) ANAHTAR-KELİME KOMŞULUĞU (token/api_key/secret/parola/jeton/bearer + `:`/`=`
//      + uzun değer): biçimi ayırt edici olmayan jetonlar (Hostinger/Coolify/n8n)
//      ancak böyle yakalanır.
//
// 🪤 BİLEREK MASKELENMEYEN: çıplak onaltılık diziler. Hafıza dosyaları commit sha'sı
// KAYNIYOR ("commit 66394f63", "gitCommit 31ca5290"); onları maskelemek her ikinci
// satırı okunmaz yapar ve sha bir sır DEĞİLDİR. 40+ hanelik onaltılık ancak anahtar
// kelimeyle komşuysa (B sınıfı) maskelenir.
//
// Saf: node builtin bile yok → `node --test` ile koşar, hem main hem CLI kullanır.

'use strict';

/** Değerin YERİNE yazılan iz. Uzunluğu bile sızdırmaz (hep aynı). */
const MASK = '••••[gizlendi]';

/**
 * A SINIFI — kendini tanıtan jeton biçimleri. Her deseni ayrı tutuyoruz ki hangi
 * sınıfın eşleştiği ölçülebilsin (kanıt koşusunda sayılır).
 * ⚠ Global bayrak (`g`) ZORUNLU: bir satırda birden çok jeton olabilir.
 */
const SELF_IDENTIFYING = Object.freeze([
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{12,}/g },
  { name: 'openai-style', re: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'google', re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { name: 'aws', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'huggingface', re: /\bhf_[A-Za-z0-9]{20,}/g },
  // SEC-W2-A4 — ASAR-R1 §2'nin kategori listesinde VARDI, burada YOKTU. İkisi de
  // kendini tanıtan ön ekler: `sk_live_…` PARA HAREKETİ (tahsilat/iade) yetkisi,
  // `re_…` bizim adımıza e-posta. `openai-style` deseni bunları GÖRMEZ — o `sk-`
  // (tire) arar, Stripe `sk_` (alt çizgi) kullanır.
  { name: 'stripe', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  // Resend biçimi iki parçalıdır (`re_<id>_<gizli>`); tek parçalı `re_…` ararsak
  // küçültülmüş JS'teki değişken adları yanlış pozitif verir.
  { name: 'resend', re: /\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{16,}/g },
  // JWT (Supabase anon/service jetonları dahil): üç base64url parça.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // Sohbet-botu jetonu biçimi: <8-12 hane>:<30+ karakter>. Ekip hafızasındaki gerçek vaka.
  { name: 'bot-token', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}/g },
]);

/**
 * B SINIFI — anahtar kelime + ayraç + UZUN değer.
 * Değer eşiği 12 karakter: altında sıradan Türkçe metin ("parola: yok", "token: bak")
 * maskelenir ve sonuç okunmaz hale gelirdi. Değerin en az bir rakam VEYA `-_./+=`
 * içermesi de aranır — düz bir kelime ("password: değiştirilmeli") sır değildir.
 */
const KEYWORDS = 'token|api[_-]?key|apikey|access[_-]?key|secret|password|passwd|pwd|parola|şifre|sifre|jeton|anahtar|bearer|authorization|auth[_-]?token|client[_-]?secret';
const KEYWORD_ADJACENT = new RegExp(
  `(${KEYWORDS})(["'\`]?\\s*[:=]\\s*["'\`]?|\\s+)([A-Za-z0-9_\\-./+=]{12,})`,
  'gi',
);
/** Değer gerçekten "jeton gibi" mi? Saf. */
function looksLikeSecretValue(v) {
  if (typeof v !== 'string' || v.length < 12) return false;
  return /[0-9]/.test(v) || /[-_./+=]/.test(v);
}

/** PEM blokları: satır bazlı, tamamı gider. */
const PEM_BLOCK = /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g;

/**
 * Metindeki sır-benzeri değerleri maskele.
 * @param {string} text
 * @returns {{ text: string, masked: number, kinds: string[], counts: Object<string,number> }}
 *   `masked` = değiştirilen parça sayısı, `counts` = SINIF BAZINDA adet (SEC-W2-A4 paket
 *   kapısı "kategori + adet" basar; DEĞERLER asla dönmez).
 */
function maskSecretsDetailed(text) {
  if (typeof text !== 'string' || !text) {
    return { text: typeof text === 'string' ? text : '', masked: 0, kinds: [], counts: {} };
  }
  let out = text;
  let masked = 0;
  const kinds = [];
  const counts = Object.create(null);
  const hit = (name) => {
    masked += 1;
    counts[name] = (counts[name] || 0) + 1;
    if (!kinds.includes(name)) kinds.push(name);
  };

  out = out.replace(PEM_BLOCK, () => {
    hit('pem');
    return MASK;
  });

  for (const { name, re } of SELF_IDENTIFYING) {
    // ⚠ Paylaşılan RegExp nesnesi `g` bayrağıyla lastIndex TAŞIR — her kullanımda
    // sıfırlanmazsa ikinci çağrı ilk eşleşmeyi ATLAR (sessiz sızıntı).
    re.lastIndex = 0;
    out = out.replace(re, () => {
      hit(name);
      return MASK;
    });
  }

  KEYWORD_ADJACENT.lastIndex = 0;
  out = out.replace(KEYWORD_ADJACENT, (whole, kw, sep, val) => {
    if (!looksLikeSecretValue(val)) return whole;
    hit('keyword');
    return `${kw}${sep}${MASK}`;
  });

  return { text: out, masked, kinds, counts: { ...counts } };
}

/** Kısa yol: yalnız maskelenmiş metin. */
function maskSecrets(text) {
  return maskSecretsDetailed(text).text;
}

/** Metinde maskelenecek bir şey var mı (kapı/ölçüm için). */
function containsSecret(text) {
  return maskSecretsDetailed(text).masked > 0;
}

/**
 * Nesne/dizi içindeki TÜM string'leri maskele (IPC dönüşü gibi yapılandırılmış yük).
 * Döngüsel referans korunur. secretRedactor.redactDeep ile AYNI şekil — ikisi
 * arka arkaya uygulanabilir (kayıtlı değer + desen).
 */
function maskDeep(value, seen = new WeakSet()) {
  if (typeof value === 'string') return maskSecrets(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, seen));
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, seen);
  return out;
}

module.exports = {
  MASK,
  KEYWORDS,
  SELF_IDENTIFYING,
  looksLikeSecretValue,
  maskSecrets,
  maskSecretsDetailed,
  containsSecret,
  maskDeep,
};
