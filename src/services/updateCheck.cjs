// ADP-533 — Faz 1 güncelleme bildirimi: "yeni sürüm var mı?" kontrolünün saf mantığı.
//
// TAM auto-update DEĞİL. Bu modül yalnızca GitHub Releases'ın public API'sinden son
// sürümü okur ve kurulu sürümle karşılaştırır; indirme kullanıcının tarayıcısında
// olur (main.js `update:download` → shell.openExternal ile SABİT URL açar).
//
// Sessizlik sözleşmesi: ağ hatası / rate-limit / bozuk JSON → { ok:false } döner,
// ASLA throw etmez. Kullanıcı offline diye uygulama ne çöker ne de bildirim basar.
//
// ── Faz 2 GELDİ (ADP-553) ───────────────────────────────────────────────────────
// İmzalı+notarize PAKETLİ build'lerde main.js `initAutoUpdater()` electron-updater'ı
// kurar (mode:'updater' — uygulama içinde indir + kullanıcı onayıyla kur, feed =
// latest-mac.yml). Bu modül artık FALLBACK'tir (mode:'notify'): dev/unsigned
// ortamda sürüm karşılaştırıp tarayıcıya yönlendirir. `update:*` IPC yüzeyi
// iki modda aynıdır; renderer state.mode/phase'e bakar.

// ── ADP-620 — KANAL (stable|beta) ───────────────────────────────────────────────
// Stable yol DEĞİŞMEDİ: /releases/latest tek atışta doğru cevabı verir ve GitHub bu
// uç noktada prerelease'leri ATLAR → müşteri beta'yı burada da göremez. Beta yol
// AYRI bir uç nokta (releases listesi) kullanır, çünkü prerelease'ler ancak orada
// görünür. Kanal seçimi/eşleşmesi updateChannel.cjs'te (tek gerçek).
const releaseChannel = require('./updateChannel.cjs');

const RELEASES_REPO = 'crewpane-dev/crewpane-releases';
const RELEASES_LATEST_API =
  'https://api.github.com/repos/crewpane-dev/crewpane-releases/releases/latest';
/** Beta kanal: prerelease'leri de listeleyen uç nokta (yalnız beta istemci kullanır). */
const RELEASES_LIST_API =
  'https://api.github.com/repos/crewpane-dev/crewpane-releases/releases?per_page=20';
const DOWNLOAD_URL =
  'https://github.com/crewpane-dev/crewpane-releases/releases/latest/download/CrewPane-arm64.dmg';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // ~6 saat periyodik kontrol
const FETCH_TIMEOUT_MS = 10_000;

/**
 * 'v0.3.0' / '0.3.0' → [0,3,0]; parse edilemeyen her şey → null.
 * Ön-ek 'v' ve '-beta' gibi kuyruklar tolere edilir (kuyruk karşılaştırmaya girmez —
 * release tag'lerimiz düz semver, pre-release sıralaması bu fazın konusu değil).
 */
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** latest > current ise true (yalnız GERÇEKTEN yeni sürüm bildirim üretir). */
function isNewer(latest, current) {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

/** GitHub /releases/latest cevabından tag'i çek; şekil bozuksa null. */
function latestTagFrom(json) {
  if (!json || typeof json !== 'object') return null;
  const tag = json.tag_name;
  return typeof tag === 'string' && parseSemver(tag) ? tag.trim() : null;
}

/**
 * ADP-620 — notify modunda kanalın indirme adresi.
 * stable: sabit `releases/latest/download/…` (GitHub prerelease'i latest saymaz →
 *         müşteri linki ASLA beta'ya gitmez). beta: tag'e bağlı adres.
 */
function downloadUrlFor(channel, tag) {
  if (releaseChannel.normalizeChannel(channel) !== 'beta') return DOWNLOAD_URL;
  // Güvenlik: tag URL'e GİRDİĞİ için biçimi SIKI doğrulanır (channelOfTag katı bir
  // semver kalıbı uygular) — bozuk/uydurma bir feed cevabı yol enjekte edemesin.
  if (releaseChannel.channelOfTag(tag) !== 'beta') return DOWNLOAD_URL;
  const version = String(tag).replace(/^v/, '').replace(/-beta.*$/, '');
  return `https://github.com/${RELEASES_REPO}/releases/download/${tag}/CrewPane-${version}-arm64.dmg`;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIC-ENFORCE-01 — GÜNCELLEME KANALININ LİSANS KAPISI
// ─────────────────────────────────────────────────────────────────────────────
//
// Eren'in direktifi: "özellikle güncellemeleri iletirken check koyalım hâlâ aktif
// kullanıcı mı diye." Ölçülen bugünkü davranış: güncelleme akışı lisans durumuna
// HİÇ bakmıyordu → iade almış kullanıcı yeni sürümleri almaya devam ediyordu.
//
// KAPI DAR TUTULUR — yalnız sunucunun AÇIK "yetki yok" verdiği iki ret kapatır:
//   * `license_revoked` → iade/iptal damgası (LIC-ENFORCE-01 A)
//   * `no_seat`         → hesapta aktif paket yok (sunucu jetonu teslim etti)
// Diğer HER durumda güncelleme SESSİZCE geçer, çünkü onlar "bilmiyoruz" demektir:
//   * `license_unknown` (jeton hiç alınamadı — ağ/sunucu) → ÇEVRİMDIŞI ATLAMA
//   * `license_invalid` (blob bozuk), `license_expired` (bayat jeton)
//   * `not_signed_in`  (kullanıcı henüz girmemiş)
//   * kapı kapalı kopya (`requireSeat !== true`) — geliştirici/e2e
// Yani ödeyen ama internetsiz müşteri güncelleme kanalında da CEZALANDIRILMAZ.
//
// KAPSAM: yalnız YENİ SÜRÜM indirme. KURULU sürüm çalışmaya devam eder.
// LTD-SCOPE-01 (Eren 07.09): ömür boyu = TÜM güncellemeler, SÜRÜM SINIRI YOK
// ("1.x" ifadesi her yüzeyden kalktı). Bu kapı zaten sürüme/majör numaraya HİÇ
// bakmaz — yalnız aşağıdaki iki AÇIK yetki reddine bakar; yani ömür boyu sahibi
// hangi sürüm çıkarsa çıksın güncellemeyi alır.
const UPDATE_BLOCKING_DENIALS = Object.freeze(['license_revoked', 'no_seat']);

/**
 * Güncelleme kanalı bu hesaba açık mı?
 *
 * Kararı BURADA yeniden hesaplamayız: `seatGate.decideAccess`'in verdiği ret
 * sebebini okuruz (tek gerçek kaynak). İkinci bir lisans mantığı yazmak, kapının
 * iki farklı yerde iki farklı şey demesi demek olurdu.
 *
 * @param {object|null} account - seatGate snapshot (`state()`/`evaluate()`)
 * @returns {{allowed:true}|{allowed:false, reason:string, message:string, billingUrl:string|null}}
 */
function updateLicenseGate(account) {
  if (!account || account.requireSeat !== true) return { allowed: true };
  if (account.accessAllowed !== false) return { allowed: true };
  const denial = account.denial || {};
  if (!UPDATE_BLOCKING_DENIALS.includes(denial.reason)) return { allowed: true };
  return {
    allowed: false,
    reason: denial.reason,
    // Dürüst cümle: ne olduğunu söyler, YALAN söylemez ("güncel" demez) ve
    // kurulu sürümün çalışmaya devam ettiğini AÇIKÇA yazar.
    message: denial.reason === 'license_revoked'
      ? 'Aboneliğin sona erdiği için yeni sürümler indirilmiyor. Kurulu sürüm '
        + 'çalışmaya devam eder; güncellemeler için planını yenile.'
      : 'Bu hesapta aktif bir CrewPane paketi olmadığı için yeni sürümler '
        + 'indirilmiyor. Kurulu sürüm çalışmaya devam eder; güncellemeler için bir paket al.',
    billingUrl: account.billingUrl || null,
  };
}

/**
 * Son sürümü sor ve kurulu sürümle karşılaştır.
 * → { ok:true, updateAvailable, latestVersion, currentVersion, channel, downloadUrl }
 * → { ok:false, reason }  (her hata yolu; ASLA throw etmez — sessiz geç sözleşmesi)
 *
 * `url` ve `fetchImpl` test dikişleri: e2e yerel mock sunucusuna yönlendirir
 * (CREWPANE_UPDATE_FEED_URL), unit test sahte fetch verir.
 * `channel` (ADP-620): 'beta' ise prerelease'leri de listeleyen uç nokta kullanılır;
 * 'stable' (varsayılan) yol BİT BİT eskisiyle aynıdır (regresyon yok).
 */
async function checkForUpdate({ currentVersion, channel = 'stable', url = null, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const ch = releaseChannel.normalizeChannel(channel) || 'stable';
  if (!url) url = ch === 'beta' ? RELEASES_LIST_API : RELEASES_LATEST_API;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CrewPane-update-check' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return { ok: false, reason: `http-${res ? res.status : 'null'}` };
    const payload = await res.json();
    // Beta: cevap bir LİSTE (prerelease dahil) → kanala uyan en yeniyi seç.
    // Stable: cevap tek release nesnesi → eski yol, aynen.
    const tag = Array.isArray(payload)
      ? releaseChannel.pickReleaseTag(payload, ch)
      : latestTagFrom(payload);
    if (!tag) return { ok: false, reason: 'bad-payload' };
    return {
      ok: true,
      updateAvailable: isNewer(tag, currentVersion),
      latestVersion: tag,
      currentVersion,
      channel: ch,
      downloadUrl: downloadUrlFor(ch, tag),
    };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

module.exports = {
  RELEASES_LATEST_API,
  // LIC-ENFORCE-01 — güncelleme kanalının lisans kapısı
  UPDATE_BLOCKING_DENIALS,
  updateLicenseGate,
  RELEASES_LIST_API, // ADP-620 — beta kanal uç noktası
  RELEASES_REPO,
  DOWNLOAD_URL,
  downloadUrlFor, // ADP-620
  CHECK_INTERVAL_MS,
  parseSemver,
  isNewer,
  latestTagFrom,
  checkForUpdate,
};
