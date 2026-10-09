'use strict';

const { DEFAULT_MASK } = require('./constants.cjs');
const { get } = require('./helpers.cjs');

/**
 * Maskeleme — UI/log/transcript'te secret'ın YERİNE geçen tek gösterim.
 * Kısa secret'ta baş/son parçalar çakışırsa TAMAMEN maskelenir (sızdırmaktansa
 * hiçbir şey gösterme). Dönüş asla ham secret'ı içermez.
 */

/**
 * INT-0-E — BAĞLANTI DİZESİ (DSN) MASKESİ.
 *
 * `{keepPrefix, keepSuffix}` profili bir API anahtarı için doğrudur ama bir DSN'de
 * YIKICIDIR: bir DSN'in SON parçası daima yol/veritabanı bölgesidir, yani
 * `keepSuffix` doğrudan MÜŞTERİ BİLGİSİ gösterir (ölçüldü: `postgres://root:toor@
 * localhost/app` → `po••••/app`). Bu profil bunun yerine dizeyi AYRIŞTIRIR ve
 * yalnız iki şeyi bırakır: ŞEMA (kullanıcı ne tür bağlantı olduğunu bilmeli) ve
 * host'un SON İKİ ETİKETİ (sağlayıcı: `supabase.co`, `mongodb.net`).
 *
 * Gizlenen: kullanıcı adı · parola · port · veritabanı adı · query string ·
 * host'un kiracı/proje etiketleri · IP adresinin tamamı.
 *
 * AYRIŞTIRILAMAYAN dize TAMAMEN maskelenir — `maskSecret`in "sızdırmaktansa hiçbir
 * şey gösterme" duruşu (kısa secret dalı) burada da geçerlidir. libpq'nun
 * `host=… user=…` anahtar-değer biçimi ve unix-socket varyantları bu dala düşer:
 * ayrıştırmayı zorlamak, yanlış ayrıştırıp parolayı "host" sanmak demek olurdu.
 */
function maskDsn(secret) {
  let u;
  try {
    u = new URL(secret);
  } catch {
    return '••••';
  }
  if (!u.protocol || !u.hostname) return '••••';
  const scheme = u.protocol.replace(/:$/, '');
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) return '••••';

  // Host: IP ise TAMAMEN gizle (bir IP doğrudan kimliktir). Alan adında yalnız son
  // iki etiket kalır → sağlayıcı tanınır, kiracı/proje tanınmaz.
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const isIp = /^[0-9.]+$/.test(host) || host.includes(':');
  let shownHost;
  if (isIp) shownHost = '••••';
  else {
    const labels = host.split('.').filter(Boolean);
    shownHost = labels.length > 2 ? `••••.${labels.slice(-2).join('.')}` : host;
  }
  return `${scheme}://••••@${shownHost}/••••`;
}

function maskSecret(secret, service) {
  if (typeof secret !== 'string' || secret.length === 0) return '';
  const spec = (get(service) || {}).mask || DEFAULT_MASK;
  if (spec.kind === 'dsn') return maskDsn(secret);
  const keepPrefix = Math.max(0, spec.keepPrefix | 0);
  const keepSuffix = Math.max(0, spec.keepSuffix | 0);
  // 4 karakterlik güvenlik payı: baş+son, secret'ın tamamını ele vermemeli.
  if (secret.length < keepPrefix + keepSuffix + 4) return '••••';
  return `${secret.slice(0, keepPrefix)}••••${secret.slice(-keepSuffix)}`;
}

module.exports = {
  maskDsn,
  maskSecret,
};
