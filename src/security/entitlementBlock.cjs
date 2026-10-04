// SEC-W3-B1b-S — "SUNUCU YAZMAYI REDDETTİ, SEBEBİ ABONELİK" — TEK KARAR YERİ.
//
// ─── NEDEN TEK MODÜL ─────────────────────────────────────────────────────────
// Ölçülen arıza (PAY-3D-CHECK-01 §3, 19.09 PROD): sunucudaki yazma kapısı
// çalışıyordu ama istemcide bu reddi TANIYAN hiçbir yer yoktu. Sonuç dört ayrı
// yüzeyde dört ayrı yanlış davranıştı:
//   • ofis presence yazıcısı hatayı YUTTU → 14 saat boyunca 2 sn'de bir aynı
//     yazımı denedi (14 668 ret), kullanıcıya 0 cümle, telemetriye 0 olay,
//   • bulut senkron kuyruğu reddi "oturum" sandı → "Yeniden giriş yap" dedi
//     (yeniden giriş aynı reddi yer; kullanıcı çözümü olmayan bir döngüye girer),
//   • lisans şeridi aynı anda "şimdilik her şey açık" yazıyordu,
//   • board/MCP yolları ham PostgREST metnini taşıdı.
// Dördü de aynı olguyu farklı okuduğu için düzeltme de tek yerde olmalı: bu
// dosya o olgunun TEK tanımıdır. Yüzeyler karar VERMEZ, buraya SORAR.
//
// ─── SINIFLANDIRMANIN İKİ YÖNÜ AYNI ÖNEMDE ──────────────────────────────────
// Yanlış NEGATİF = bugünkü sessizlik (kullanıcı hiçbir şey görmez).
// Yanlış POZİTİF = ödeyen müşteriye "aboneliğin ödenmedi" yalanı — yani
// düzelttiğimiz kusurun aynadaki hâli. Bu yüzden ölçüt "42501 gördüm" DEĞİLDİR:
// PROD'da son 24 saatte 13 985 `permission denied for schema app` satırı var
// (LIVE-01 §10) ve o satırlar da SQLSTATE 42501 taşır. Kurulum/yetki reddi ile
// politika (satır düzeyi) reddi burada AYRI tutulur ve ikisi de testlidir.
//
// LEAF MODÜL: hiç require yok → hem main (`electron/**`) hem renderer
// (`src/app/**`) hem `node --test` doğrudan yükler. İkinci bir kopya YOKTUR.

'use strict';

/** PostgreSQL SQLSTATE: insufficient_privilege. RLS reddi de, GRANT reddi de bu. */
const PG_INSUFFICIENT_PRIVILEGE = '42501';

/**
 * POLİTİKA reddi — sunucudaki abonelik kapısının imzası. PostgREST bu cümleyi
 * INSERT/UPDATE/UPSERT için birebir döner ("new row violates row-level security
 * policy for table …"); tablo adı değişse de kalıp sabittir.
 */
const POLICY_DENIAL_RE = /row[-\s]?level security/i;

/**
 * KURULUM/YETKİ reddi — abonelikle İLGİSİ YOK. Rolün şemayı/tabloyu hiç
 * görememesi bir GRANT sorunudur (ya da anonim istek). Aynı SQLSTATE'i taşır,
 * bu yüzden ADIYLA dışarıda bırakılır — yoksa PROD'un 13 985 satırlık gürültüsü
 * ödeyen kullanıcılara ödeme şeridi bastırırdı.
 */
const GRANT_DENIAL_RE = /permission denied for (schema|table|relation|view|function|sequence|column)/i;

/** `{status, code, message}` — supabase-js hatası, PostgREST gövdesi ya da ikisi. */
function fieldsOf(input) {
  if (!input || typeof input !== 'object') return { status: 0, code: '', message: '' };
  const status = Number.isFinite(input.status) ? Number(input.status) : 0;
  const code = typeof input.code === 'string' ? input.code : '';
  const message = typeof input.message === 'string' ? input.message : '';
  return { status, code, message };
}

/**
 * "Bu yazma reddi ABONELİK yüzünden mi?"
 *
 * Kural (iki yönü de `entitlementBlock.test.cjs`'te kilitli):
 *   1. SQLSTATE 42501 ⇒ evet — AMA metin bir GRANT/şema reddi ise HAYIR.
 *   2. Kod gelmemişse: yalnız 403 + politika metni ⇒ evet.
 *   3. Başka her şey (401, 429, 5xx, kanıtsız 403) ⇒ HAYIR.
 *
 * 401 bilerek dışarıdadır: o bir OTURUM sorunudur ve cümlesi başkadır
 * ("yeniden giriş"). Abonelik saymak, iki ayrı arızayı tek yanlış cümlede
 * birleştirirdi — kartın düzelttiği şeyin ta kendisi.
 */
function isEntitlementBlocked(input) {
  const { status, code, message } = fieldsOf(input);
  if (code === PG_INSUFFICIENT_PRIVILEGE) return !GRANT_DENIAL_RE.test(message);
  if (status === 403 && POLICY_DENIAL_RE.test(message)) return true;
  return false;
}

/** Aynı karar, yüzeylerin `switch`'lerine uyan biçimde. */
function classifyWriteError(input) {
  return isEntitlementBlocked(input) ? 'entitlement' : null;
}

// ─── GERİ ÇEKİLME ───────────────────────────────────────────────────────────
// Abonelik reddi ANLIK bir arıza değildir: kullanıcı kartını güncelleyene kadar
// (saatler) sürer. Bu yüzden yazıcıların normal temposu (presence: 2 sn) burada
// anlamsızdır — ölçülen 14 668 ret tam olarak bunun faturasıdır.
//
// Yine de TAMAMEN durmak yanlış olurdu: ödeme geldiğinde yazımı yeniden
// başlatacak bir sinyal yok (kapıyı açan olay sunucuda olur, istemcide değil).
// Bir sonraki denemeyi ancak DENEMENİN KENDİSİ getirebilir. Bu yüzden kural
// "dur" değil "seyrel + tavanda kal": yük ~%99,9 düşer, kurtarma yolu kapanmaz.
const ENTITLEMENT_BACKOFF_STEPS_MS = Object.freeze([
  30_000,   // 30 sn
  60_000,   // 1 dk
  120_000,  // 2 dk
  300_000,  // 5 dk
]);
const ENTITLEMENT_BACKOFF_MAX_MS = 600_000; // 10 dk

/**
 * Kaçıncı arka arkaya abonelik reddinden sonra ne kadar beklenecek.
 * @param {number} attempt 1'den başlar (ilk ret = 1).
 */
function entitlementBackoffMs(attempt) {
  const n = Number.isFinite(attempt) ? Math.floor(attempt) : 1;
  if (n <= 0) return ENTITLEMENT_BACKOFF_STEPS_MS[0];
  return ENTITLEMENT_BACKOFF_STEPS_MS[n - 1] ?? ENTITLEMENT_BACKOFF_MAX_MS;
}

module.exports = {
  isEntitlementBlocked,
  classifyWriteError,
  entitlementBackoffMs,
  ENTITLEMENT_BACKOFF_MAX_MS,
  ENTITLEMENT_BACKOFF_STEPS_MS,
  PG_INSUFFICIENT_PRIVILEGE,
};
