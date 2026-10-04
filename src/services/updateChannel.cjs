'use strict';
// ADP-620 — YAYIN KANALI (stable | beta): müşteri YALNIZ stable görür, biz beta'dan
// önce deneriz. Bu dosya kanalın TEK GERÇEĞİ: ad çözümü, dosya adı, tag biçimi ve
// electron-updater'a uygulama kuralı burada — main.js/release.sh/updateCheck aynı
// kaynağa bakar (kopya mantık = iki kanalın sessizce ayrışması).
//
// ── MODEL (electron-updater 6.8.9 KAYNAĞINDAN doğrulandı, tahmin değil) ─────────
// Kanal ayrımı ÜÇ şeyden oluşur; üçü birden doğru olmazsa ayrım YOK:
//   1. GitHub release'in TAG'i        : stable `v0.2.15` · beta `v0.2.15-beta`
//   2. GitHub'ın "prerelease" bayrağı : beta release'i PRERELEASE işaretlenir
//   3. feed dosyasının ADI            : stable `latest-mac.yml` · beta `beta-mac.yml`
//
// NEDEN üçü de gerekli (GitHubProvider.js okundu):
//  · allowPrerelease=false (stable istemci) → `getLatestTagName()` GitHub'ın
//    `/releases/latest` uç noktasını okur; GitHub bu uç noktada PRERELEASE'leri
//    ATLAR → stable istemci beta release'i GÖREMEZ. Bayrak (2) bu yüzden şart.
//  · allowPrerelease=true + channel='beta' (beta istemci) → atom feed'i gezer,
//    tag'in semver ön-yayın bileşenine bakar (`semver.prerelease('v0.2.15-beta')[0]`
//    === 'beta') → tag biçimi (1) bu yüzden şart. Sonra o tag'ten `beta-mac.yml`
//    ister; 404 alırsa `latest-mac.yml`'e DÜŞER (yalnız allowPrerelease modunda) —
//    yani beta istemci daha yeni bir STABLE sürümü de alır (istenen davranış).
//  · Dosya adı (3) `getCustomChannelName(channel) + '.yml'` ile üretilir; mac'te
//    '-mac' eki gelir → `beta-mac.yml` / `latest-mac.yml`.
//
// ── KRİTİK KARAR: KANAL PAKETE GÖMÜLMEZ (app-update.yml'de `channel:` YOK) ──────
// electron-builder'ın publish config'ine `channel: beta` yazmak `app-update.yml`e
// `channel: beta` gömer. O zaman PROMOTE (beta'da denenmiş AYNI baytları stable'a
// taşımak) İMKANSIZ olur: promote edilen build stable kullanıcıda da beta-mac.yml
// arar, bulamaz (allowPrerelease=false → fallback YOK) ve güncelleme KIRILIR.
// Bu yüzden kanal RUNTIME'da seçilir (aşağıdaki applyChannel), pakette değil;
// `beta-mac.yml` release.sh'ta `latest-mac.yml`in BİREBİR kopyasıdır (yml'in içinde
// kanal alanı yoktur — kanal yalnız DOSYA ADIDIR). release.sh bunu kapıyla korur.

const CHANNELS = ['stable', 'beta'];
/** electron-updater'da stable kanalın adı 'latest'tir (dosya: latest-mac.yml). */
const UPDATER_CHANNEL_NAME = { stable: 'latest', beta: 'beta' };

/** 'stable'|'beta' → kendisi; 'auto'/çöp/boş/null → null (= "karar verilmedi"). */
function normalizeChannel(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return CHANNELS.includes(v) ? v : null;
}

/**
 * Uygulamanın dinleyeceği kanal.
 * Öncelik: env dikişi (e2e/geçici override) → kullanıcının AÇIK tercihi (Ayarlar) →
 * instance varsayılanı. Ayar 'auto'/yok ise instance karar verir — bu yüzden müşteri
 * hiçbir şey ayarlamadan stable'da kalır.
 *
 * Instance varsayılanı YALNIZ 'dev' için beta'dır:
 *  · 'prod'  = MÜŞTERİ  → stable (beta'yı hiç görmez)
 *  · 'dev'   = geliştirici günlük kurulumu → beta (kendi sürümümüzü önce biz yeriz)
 *  · 'test'  = E2E KOŞUM ORTAMI → stable. Test instance'ını beta'ya almak, kanalla
 *    hiç ilgisi olmayan spec'lerin feed davranışını sessizce değiştirir (ADP-553'ün
 *    generic-provider mock'u yalnız latest-mac.yml sunar → beta istemci beta-mac.yml
 *    isteyip 404 alır, rozet çıkmaz, spec KIRILIR). Ölçülen gerçek: bu kural
 *    konmadan önce ADP-553 S1 gerçekten kırmızıya döndü. Kanal test etmek isteyen
 *    spec kanalı AÇIKÇA verir (settings.json ya da CREWPANE_UPDATE_CHANNEL).
 */
function resolveChannel({ settingsValue = null, instanceId = 'prod', envValue = null } = {}) {
  return (
    normalizeChannel(envValue) ||
    normalizeChannel(settingsValue) ||
    (instanceId === 'dev' ? 'beta' : 'stable')
  );
}

/** Kanalın feed dosyası adı (electron-updater `getCustomChannelName` + '.yml'). */
function channelFileName(channel, platform = 'darwin') {
  const name = UPDATER_CHANNEL_NAME[normalizeChannel(channel) || 'stable'];
  const suffix = platform === 'darwin' ? '-mac' : platform === 'linux' ? '-linux' : '';
  return `${name}${suffix}.yml`;
}

/** GitHub release tag'i: stable `v0.2.15` · beta `v0.2.15-beta` (semver ön-yayın!). */
function releaseTag(version, channel) {
  const v = String(version || '').replace(/^v/, '');
  return normalizeChannel(channel) === 'beta' ? `v${v}-beta` : `v${v}`;
}

/** Tag → kanal. `v1.2.3-beta`/`v1.2.3-beta.2` → 'beta'; düz semver → 'stable'; çöp → null. */
function channelOfTag(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  if (!m[4]) return 'stable';
  return m[4].split('.')[0].toLowerCase() === 'beta' ? 'beta' : null;
}

/**
 * electron-updater örneğine kanalı uygula. SIRA ÖNEMLİ: `channel` setter'ı
 * electron-updater'da `allowDowngrade = true` yapar (kaynak: AppUpdater.js:44) —
 * geri sürüme düşmeyi İSTEMİYORUZ, o yüzden allowDowngrade EN SON false'lanır.
 * Her kontrolde yeniden çağrılabilir (Ayarlar'daki toggle restart'sız etki etsin).
 */
function applyChannel(updater, channel) {
  const ch = normalizeChannel(channel) || 'stable';
  if (!updater || typeof updater !== 'object') return ch;
  if (ch === 'beta') {
    updater.channel = 'beta';
    // Beta istemci ön-yayın tag'lerini GÖRMELİ; ayrıca 404'te latest-mac.yml'e
    // düşme davranışı YALNIZ bu bayrak açıkken çalışır (GitHubProvider.js).
    updater.allowPrerelease = true;
  } else {
    // 'latest' = electron-updater'ın varsayılan kanal adı → latest-mac.yml.
    // (null ATANAMAZ: setter bir kez string aldıktan sonra null'ı reddediyor →
    //  toggle beta→stable dönüşü bu yüzden 'latest' ile yapılır.)
    updater.channel = 'latest';
    updater.allowPrerelease = false; // müşteri prerelease'i ASLA görmez
  }
  updater.allowDowngrade = false; // channel setter'ının yan etkisini geri al
  return ch;
}

/**
 * Notify fallback'i (paketlenmemiş/imzasız build, ADP-533) için: GitHub
 * /releases listesinden kanala uyan EN YENİ sürümü seç. Stable yolda bu fonksiyon
 * KULLANILMAZ (orada /releases/latest tek atışta doğru cevabı verir) — yalnız beta
 * istemcinin ön-yayınları görebilmesi için var.
 * releases: GitHub API şekli [{tag_name, prerelease, draft}] · → tag | null
 */
function pickReleaseTag(releases, channel) {
  if (!Array.isArray(releases)) return null;
  const want = normalizeChannel(channel) || 'stable';
  let best = null;
  let bestKey = null;
  for (const r of releases) {
    if (!r || r.draft) continue;
    const tag = typeof r.tag_name === 'string' ? r.tag_name : null;
    const ch = channelOfTag(tag);
    if (!ch) continue;
    // stable istemci prerelease'i ASLA almaz; beta istemci ikisini de alabilir
    // (daha yeni bir stable, beta'dan üstündür — kanal "daha çok sürüm" demektir).
    if (want === 'stable' && (ch !== 'stable' || r.prerelease)) continue;
    const key = tagSortKey(tag);
    if (!key) continue;
    if (!bestKey || cmpKey(key, bestKey) > 0) { best = tag; bestKey = key; }
  }
  return best;
}

/** [major,minor,patch,preRank] — ön-yayın (beta) aynı sürümün stable'ından ÖNCE gelir. */
function tagSortKey(tag) {
  const m = String(tag).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1];
}
function cmpKey(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

module.exports = {
  CHANNELS,
  UPDATER_CHANNEL_NAME,
  normalizeChannel,
  resolveChannel,
  channelFileName,
  releaseTag,
  channelOfTag,
  applyChannel,
  pickReleaseTag,
};
