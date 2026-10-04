// SEC-01 (inferno) — CİHAZ DEFTERİ İSTEMCİSİ: listele + çıkar.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN BU DOSYA VAR
// ─────────────────────────────────────────────────────────────────────────────
// Cihaz TAVANI sunucuda (`license-token`) zorlanıyor. Bir tavanın müşteriyi
// KİLİTLEMEMESİ için tek şart var: kullanıcı kendi cihazını kendisi ÇIKARABİLMELİ.
// Aksi hâlde eski dizüstünü satmış bir Basic kullanıcısı yeni makinesinde jeton
// alamaz ve tek çıkış yolu destek talebidir — yani tavan, gelir korumak yerine
// destek yükü üretir (SEC-01 §5: "atlanamaz madde").
//
// YÜZEY: yeni bir Edge Function YOK. `public.devices` tablosunun RLS'i bu iki
// eylemi ZATEN tam olarak modelliyor:
//   * SELECT  → kullanıcı yalnız kendi cihazlarını görür
//   * UPDATE  → yalnız `revoked_at is null` satırı, yalnız `revoked_at` DOLU
//               sonucuyla güncellenebilir (yani "geri al" RLS'te imkânsız)
// Bu yüzden PostgREST'e kullanıcının KENDİ JWT'siyle gidilir. Sunucuda ek bir kod
// yolu açmamak, denetlenecek yüzeyi küçük tutar.
//
// ⛔ INSERT bilerek YOK: kullanıcı kendine cihaz ekleyebilseydi tavan hiçbir şey
//    ifade etmezdi. Cihaz kaydını YALNIZ license-token (service-role) atar.

'use strict';

const SELECT_COLUMNS = 'device_id,device_name,platform,app,first_seen_at,last_seen_at,revoked_at,grandfathered_at';

function requireOpts(fnName, o, extra = []) {
  const missing = ['supabaseUrl', 'apiKey', 'getAccessToken', ...extra]
    .filter((k) => (k === 'getAccessToken' ? typeof o[k] !== 'function' : !o[k]));
  if (missing.length) throw new Error(`${fnName}: ${missing.join(', ')} zorunlu`);
}

function restBase(supabaseUrl) {
  return `${String(supabaseUrl).replace(/\/+$/, '')}/rest/v1/devices`;
}

/**
 * Hesaba bağlı cihazları listele (Ayarlar → Hesap).
 *
 * İPTAL EDİLENLER DE DÖNER (`revoked_at` dolu): "çıkardım, gerçekten gitti mi?"
 * sorusunun cevabı ekranda görünür olmalı. Sayıma yalnız `revoked_at === null`
 * girer — bu ayrımı çağıran değil, dönen kayıt taşır.
 *
 * @param {{supabaseUrl:string, apiKey:string,
 *          getAccessToken:()=>Promise<string|null>, fetch?:Function}} opts
 * @returns {Promise<{ok:true, devices:Array<object>}|{ok:false, reason:string, status?:number, detail?:string}>}
 */
async function listDevices(opts) {
  const o = opts || {};
  requireOpts('listDevices', o);
  const doFetch = o.fetch || globalThis.fetch;
  const token = await o.getAccessToken();
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'not_signed_in' };

  const url = `${restBase(o.supabaseUrl)}?select=${SELECT_COLUMNS}&order=last_seen_at.desc`;
  let res;
  try {
    res = await doFetch(url, { headers: { apikey: o.apiKey, Authorization: `Bearer ${token}` } });
  } catch (e) {
    return { ok: false, reason: 'network_error', detail: String((e && e.message) || e) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body)) {
    return {
      ok: false,
      reason: 'devices_fetch_failed',
      status: res.status,
      detail: String((body && body.message) || '').slice(0, 200),
    };
  }
  return { ok: true, devices: body };
}

/**
 * Cihazı hesaptan ÇIKAR (revoke). Satır SİLİNMEZ — `revoked_at` damgalanır.
 *
 * Sonuç ÖLÇÜLEREK döner (`Prefer: return=representation`): "204 döndü" ile
 * "satır gerçekten güncellendi" aynı şey değildir — RLS bir satırı görünmez
 * kılarsa PATCH 0 satır günceller ve HTTP yine başarı der. Sessiz başarısızlık
 * burada özellikle pahalı: kullanıcı "çıkardım" sanır, cihaz açık kalır.
 *
 * @param {{supabaseUrl:string, apiKey:string, deviceId:string,
 *          getAccessToken:()=>Promise<string|null>, fetch?:Function, nowIso?:string}} opts
 * @returns {Promise<{ok:true, device:object}|{ok:false, reason:string, status?:number, detail?:string}>}
 */
async function revokeDevice(opts) {
  const o = opts || {};
  requireOpts('revokeDevice', o, ['deviceId']);
  const doFetch = o.fetch || globalThis.fetch;
  const token = await o.getAccessToken();
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'not_signed_in' };

  const url = `${restBase(o.supabaseUrl)}?device_id=eq.${encodeURIComponent(o.deviceId)}`
    + `&revoked_at=is.null&select=${SELECT_COLUMNS}`;
  let res;
  try {
    res = await doFetch(url, {
      method: 'PATCH',
      headers: {
        apikey: o.apiKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ revoked_at: o.nowIso || new Date().toISOString() }),
    });
  } catch (e) {
    return { ok: false, reason: 'network_error', detail: String((e && e.message) || e) };
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return {
      ok: false,
      reason: 'revoke_failed',
      status: res.status,
      detail: String((body && body.message) || '').slice(0, 200),
    };
  }
  // 0 satır = zaten çıkarılmış ya da bana ait değil. Başarı SAYILMAZ.
  if (!Array.isArray(body) || body.length === 0) {
    return { ok: false, reason: 'not_found_or_already_revoked', status: res.status };
  }
  return { ok: true, device: body[0] };
}

module.exports = { listDevices, revokeDevice, SELECT_COLUMNS };
