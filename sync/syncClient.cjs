// SYNC-F1-3 (Wheeljack) — POSTGREST İSTEMCİSİ: senkronun TEK ağ yüzeyi.
//                         Tasarım: SYNC-F1-TASARIM.md §2.1 · §2.3 · §2.5 · §1.5 · §1.6
//
// ═══════════════════════════════════════════════════════════════════════════════
// BU DOSYANIN TEK İŞİ: HTTP. Karar YOK.
// ═══════════════════════════════════════════════════════════════════════════════
// Çakışma kararı (LWW), sır kapısı, eko bastırma, kuyruk — hiçbiri burada değil.
// Buranın sözü şudur: "sunucu ne dedi". `syncEngine` ne yapılacağına orada karar
// verir. Ayrım disiplin değil test edilebilirlik: `fetch` enjekte edilince bu
// modülün TAMAMI ağsız sınanır, motor da sahte bir istemciyle sınanır.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ÖLÇÜLMÜŞ ÜÇ SÖZLEŞME (2026-08-24, yerel e2e stack, gerçek PostgREST)
// ─────────────────────────────────────────────────────────────────────────────
// 1) KOŞULLU PATCH ÇALIŞIYOR: `?id=eq.<id>&rev=eq.<base>` → doğru `rev`te
//    `200` + 1 satır (yeni `rev` = base+1, ADP-650 trigger'ı sayıyor); BAYAT
//    `rev`te `200` + **0 satır**. §2.3'ün çakışma sinyali gerçek.
// 2) ÇİFT INSERT → `409` / `23505` (`crewpane_files_path_key`). §2.3'ün
//    "(a) INSERT dene, (b) 23505 ⇒ koşullu PATCH" merdiveni gerçek.
// 3) 🔴 DÜZ `PATCH deleted_at` → **401 / 42501**
//    (`new row violates row-level security policy "crewpane_files_no_tombstones"`).
//    BOARD-IMG-1'in ölçtüğü arıza BURADA DA VURUYOR — silme YALNIZ
//    `rpc/crewpane_file_tombstone` kapısından geçer. `deleteFile()` bu yüzden
//    PATCH DEĞİL RPC çağırır; başka bir yol AÇILMAZ.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 TOMBSTONE PERDESİ DELTA'YI DA KÖRLEŞTİRİYOR — ölçülmüş, tasarımdan sapma
// ─────────────────────────────────────────────────────────────────────────────
// `crewpane_files_no_tombstones` RESTRICTIVE **FOR SELECT** perdesi, silinmiş
// satırı anon/authenticated'ın gözünden TAMAMEN kaldırır. Ölçüm:
//     RPC tombstone → 200 true
//     GET …?workspace_key=eq.<ws>&select=id,rel_path,deleted_at  →  200  []
// Yani tasarım §2.5'in "delta satırı geldi, `deleted_at` dolu ⇒ yerel dosyayı SİL"
// dalı bu yetkiyle **HİÇ ÇALIŞMAZ**: satır delta'ya hiç düşmez.
// → Silme kanalı `listManifest()` + `countVisible()` üzerinden MUTABAKATtır
//   (deltaSync.ts:15'in "cursor'ın göremediği iki şey: (a) SİLME" notunun aynısı).
//   Motor yine de `deleted_at` dalını TUTAR: `service_role`/`app` ikizi gibi perdesiz
//   bir yetkide satır delta'ya düşebilir ve o zaman doğru davranmak gerekir.
//
// Saf değil ama TAM DI: `fetch` enjekte edilebilir → `node --test` ağsız koşar.

'use strict';

// SYNC-CLOUD-01 — PostgREST şema profili. Kendi başlık üretimimizi YAZMIYORUZ:
// `appDbIdentity.schemaHeaders` bu kararı ADP-621'de zaten verdi (okuma
// `Accept-Profile`, yazma ek olarak `Content-Profile`, `public` iken BAŞLIK YOK).
// İkinci bir kopya, iki ayrı gerçek demektir — board MCP'nin 404'ünü bir kez daha
// yaşamamak için aynı fonksiyon çağrılır.
const { schemaHeaders } = require('../src/config/appDbIdentity.cjs');
// SYNC-F1-7 — hesap kapsamlı sınıfların (`memory-global`, `prefs`) workspace
// anahtarı. Kaydın kendisinden gelir; burada ikinci bir 'global' sabiti YAZILMAZ.
const { GLOBAL_WORKSPACE_KEY } = require('./syncClasses.cjs');
// SEC-W3-B1b-S — "sunucu yazmayı reddetti, sebebi abonelik" hükmünün TEK yeri.
// Presence yazıcısı, kuyruk ve bu istemci AYNI fonksiyonu sorar; ikinci bir
// "42501 mi" karşılaştırması yazmak, dört yüzeyde dört farklı cümle demekti.
const { isEntitlementBlocked } = require('../src/security/entitlementBlock.cjs');

/** Tek sayfada çekilecek satır tavanı (§2.5: 200'lük partiler). */
const PAGE = 200;

/** PostgREST `Prefer: return=representation` — yazımın SONUCUNU görmeden karar verilmez. */
const PREFER_REP = 'return=representation';

/**
 * HTTP durumunu senkronun anladığı üç sınıfa indirger.
 *
 * `auth` AYRI bir sınıftır çünkü davranışı farklıdır: kuyruk yeniden DENEMEZ,
 * DURUR (§2.7 — "401/403 ⇒ kuyruk durur, yeniden giriş gerekir"). Bunu
 * `transient` saymak, geçersiz bir jetonla sonsuza dek yeniden deneyen ve her
 * turda 403 yiyen bir istemci üretirdi.
 */
function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 409) return 'duplicate';
  if (status === 429 || status >= 500) return 'transient';
  if (status >= 400) return 'permanent';
  return 'ok';
}

/**
 * SYNC-CLOUD-01 — "BULUT HENÜZ HAZIR DEĞİL" AYRI BİR SINIFTIR.
 *
 * BUG-R2'nin ölçtüğü arıza: bulutta tablo yokken PostgREST `404 PGRST205` döner,
 * `classifyStatus` bunu `permanent` sayar, kuyruk girdiyi DÜŞÜRÜR ve dosya ikinci
 * cihaza HİÇ gitmez — kullanıcı senkron sanır (116 satır log, 0 dosya). Oysa bu
 * hata DOSYAYLA İLGİLİ DEĞİLDİR: aynı bayt, arka uç hazır olduğunda sorunsuz
 * yüklenir. Bu yüzden `permanent` (=düş) değil `cloud_not_ready` (=dur ve söyle).
 *
 * İki kod bu sınıfa girer ve ikisi de "arka uç bu şemayı sunmuyor" der:
 *   • PGRST205 (404) — tablo şema önbelleğinde yok (migration uygulanmamış)
 *   • PGRST106 (406) — profil gönderdik ama şema PostgREST'e açık değil
 * Başka hiçbir 4xx buraya alınmaz: alınsaydı gerçek bir kalıcı hata (bozuk uuid,
 * ihlal edilen CHECK) kuyruğu sonsuza dek dondururdu.
 */
const CLOUD_NOT_READY_CODES = new Set(['PGRST205', 'PGRST106', 'PGRST202']);

function classifyResponse(status, json) {
  const code = json && typeof json.code === 'string' ? json.code : '';
  if ((status === 404 || status === 406) && CLOUD_NOT_READY_CODES.has(code)) return 'cloud_not_ready';
  // SEC-W3-B1b-S — ABONELİK REDDİ 'auth' DEĞİLDİR.
  //
  // Ölçüldü (PAY-3D-CHECK-01 §3): sunucudaki ödeme kapısı 403 + 42501 döndüğünde
  // bu satır yokken `classifyStatus` 'auth' diyordu, kuyruk 'auth' ile duruyordu
  // ve ayarlar ekranı "Yeniden giriş yap" yazıyordu. Yeniden giriş AYNI reddi yer:
  // kullanıcı çözümü olmayan bir döngüye giriyordu. Hükmü `entitlementBlock.cjs`
  // verir — burada ikinci bir "42501 mi" mantığı YOKTUR (şema/GRANT reddi o
  // modülde ADIYLA dışarıda tutulur, yoksa ödeyen kullanıcıya yalan söylerdik).
  if (status === 403 && isEntitlementBlocked({ status, code, message: json && json.message })) {
    return 'subscription';
  }
  // Kod taşımayan eski PostgREST sürümleri için metin yedeği (yalnız 404/406'da).
  if (status === 404 || status === 406) {
    const msg = json && typeof json.message === 'string' ? json.message : '';
    if (/could not find the (table|function)|schema cache|schema must be one of/i.test(msg)) return 'cloud_not_ready';
  }
  return classifyStatus(status);
}

/** Ağ hatası (fetch reject) — çevrimdışıyız; kalıcı değil. */
function networkError(err) {
  return { ok: false, kind: 'transient', status: 0, error: String((err && err.message) || err) };
}

function encode(v) {
  return encodeURIComponent(String(v));
}

/**
 * @param {{url:string, key:string, workspaceKey:string, companyId?:string|null,
 *          deviceId?:string|null, fetch?:Function, getToken?:Function,
 *          log?:Function, page?:number}} deps
 */
function createSyncClient(deps = {}) {
  const baseUrl = String(deps.url || '').replace(/\/+$/, '');
  const apiKey = String(deps.key || '');
  const workspaceKey = String(deps.workspaceKey || '');
  // SYNC-CLOUD-01 — KİRACI CANLI OKUNUR (jeton gibi). Kuruluş anında henüz
  // bilinmiyor olabilir: `companies` sorgusu ağ ister ve istemci senkron kurulur.
  // Değere donsaydık, çözülen kiracı istemciye HİÇ ulaşmaz, bulut sorguları ömür
  // boyu `company_id=is.null` süzer ve (trigger kolonu doldurduğu için) 0 satır dönerdi.
  const staticCompanyId = deps.companyId == null ? null : String(deps.companyId);
  const getCompanyId = typeof deps.getCompanyId === 'function' ? deps.getCompanyId : () => staticCompanyId;
  const currentCompanyId = () => {
    let v = null;
    try { v = getCompanyId(); } catch { v = null; }
    return v == null || v === '' ? null : String(v);
  };
  const deviceId = deps.deviceId == null ? null : String(deps.deviceId);
  const doFetch = typeof deps.fetch === 'function' ? deps.fetch : globalThis.fetch;
  // Hedefle BİRLİKTE seyahat eder (ADP-621): bulut `app`, yerel/e2e `public`.
  const schema = typeof deps.schema === 'string' ? deps.schema.trim() : '';
  const getToken = typeof deps.getToken === 'function' ? deps.getToken : () => apiKey;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const page = Number.isFinite(deps.page) && deps.page > 0 ? deps.page : PAGE;

  if (!baseUrl) throw new Error('syncClient: url zorunlu');
  if (!workspaceKey) throw new Error('syncClient: workspaceKey zorunlu');
  if (typeof doFetch !== 'function') throw new Error('syncClient: fetch yok (enjekte et)');

  function headers(extra = {}, method = 'GET') {
    const token = getToken() || apiKey;
    return {
      apikey: apiKey,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Profil başlığı EXTRA'DAN ÖNCE serilir ki çağıran gerekirse ezebilsin;
      // bugün hiçbiri ezmiyor, ama sıranın kendisi bir karardır.
      ...schemaHeaders(schema, method),
      ...extra,
    };
  }

  /**
   * KİRACI SÜZGECİ — her sorguya AYNI biçimde eklenir.
   *
   * `company_id` NULL olabilir (`public` şeması, tek kullanıcılı yerel kurulum) ve
   * PostgREST'te `company_id=eq.null` HİÇBİR satırı getirmez; doğru süzgeç
   * `company_id=is.null`dur. İki ayrı yerde yazılsaydı biri unutulur ve senkron
   * "hiç satır yok" derdi — sessiz ve teşhisi zor bir arıza.
   */
  function tenantFilter() {
    const companyId = currentCompanyId();
    return companyId ? `company_id=eq.${encode(companyId)}` : 'company_id=is.null';
  }

  /**
   * 🔴 KAPSAM SÜZGECİ — İKİ KAPSAM, TEK SORGU (SYNC-F1-7 ölçümü).
   *
   * Sınıf kaydında iki KAPSAM var (`syncClasses` `scope`): `workspace` sınıfları
   * `workspace_key='ws-…'` ile, `account` sınıfları (`memory-global`, `prefs`)
   * `workspace_key='global'` ile yazılır (`workspaceKeyFor`). YAZMA yolu bunu
   * zaten doğru yapıyordu; OKUMA yolu yapmıyordu: `eq.<ws-key>` süzgeci hesap
   * kapsamlı satırları HİÇ getirmiyordu.
   *
   * ÖLÇÜLEN ARIZA (SYNC-F1-7 iki-profil kapısı, 2026-09-03): A profili
   * `prefs/app-prefs.json`i BAŞARIYLA yükledi (`pushed:1`, satır DB'de), B profili
   * `listDelta` ile HİÇ göremedi (`rows:[]`, cursor null) — yani hesap kapsamlı
   * hiçbir dosya ikinci cihaza inmiyordu. Aynı arıza `memory-global` (global
   * hafıza) için de yürürlükteydi ve sessizdi: hiçbir test o kapsamın gidiş-dönüşünü
   * ölçmüyordu, `e2e/syncf17-prefs-two-device.test.cjs` T1 onu kırmızı yaktı.
   *
   * Çağıran AÇIK bir `wsKey` verdiyse (çakışma anındaki `getByRelPath`, satırın
   * kapsamını ZATEN bilir) tek kapsam sorulur; vermediyse ikisi birden.
   */
  function scopeFilter(wsKey) {
    if (wsKey) return `${tenantFilter()}&workspace_key=eq.${encode(wsKey)}`;
    return `${tenantFilter()}&workspace_key=in.(${encode(workspaceKey)},${encode(GLOBAL_WORKSPACE_KEY)})`;
  }

  async function request(pathAndQuery, init = {}) {
    let res;
    try {
      res = await doFetch(`${baseUrl}${pathAndQuery}`, init);
    } catch (err) {
      return networkError(err);
    }
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    let json = null;
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    // Sınıflandırma GÖVDEYİ de okur: "tablo yok" 404'ü ile "bozuk uuid" 400'ü
    // aynı kovaya girerse birincisi dosyayı düşürür (SYNC-CLOUD-01).
    const kind = classifyResponse(res.status, json);
    if (kind !== 'ok') {
      const msg = (json && (json.message || json.error)) || text.slice(0, 300);
      return { ok: false, kind, status: res.status, error: msg, body: json };
    }
    return { ok: true, kind: 'ok', status: res.status, body: json, headers: res.headers, raw: text };
  }

  // ── OKUMA ────────────────────────────────────────────────────────────────────

  /** Gövdesiz manifest (§2.6/2, §2.5 mutabakat) — 1.500 satır ≈ 120 KB. */
  async function listManifest(opts = {}) {
    const select = 'id,class,rel_path,sha256,size_bytes,updated_at,rev';
    const rows = [];
    let offset = 0;
    for (;;) {
      const q = `/rest/v1/crewpane_files?${scopeFilter(opts.workspaceKey)}`
        + `&select=${select}&order=rel_path.asc&limit=${page}&offset=${offset}`;
      const r = await request(q, { headers: headers() });
      if (!r.ok) return r;
      const batch = Array.isArray(r.body) ? r.body : [];
      rows.push(...batch);
      if (batch.length < page) break;
      offset += page;
      // Kaçak nöbeti: 100 sayfa = 20.000 satır; tarayıcının MAX_FILES tavanıyla aynı.
      if (offset > page * 100) { log('[sync-client] ⚠ manifest sayfalama tavanı — KISMİ'); break; }
    }
    return { ok: true, rows };
  }

  /**
   * Delta çekimi (§2.5). `since` ISO damgası; TEK sayfa döner + `hasMore`.
   * Sayfalamayı motor yönetir çünkü cursor ilerletme kararı ONUN (`maxStamp`).
   */
  async function listDelta(since, opts = {}) {
    const select = 'id,class,rel_path,sha256,size_bytes,body,body_encoding,updated_at,rev,deleted_at,origin_device';
    const sinceFilter = since ? `&updated_at=gt.${encode(since)}` : '';
    const q = `/rest/v1/crewpane_files?${scopeFilter(opts.workspaceKey)}${sinceFilter}`
      + `&select=${select}&order=updated_at.asc,id.asc&limit=${page}`;
    const r = await request(q, { headers: headers() });
    if (!r.ok) return r;
    const rows = Array.isArray(r.body) ? r.body : [];
    return { ok: true, rows, hasMore: rows.length >= page };
  }

  /** Bootstrap partisi (§2.6/4): yalnız EKSİK yolların gövdeleri. */
  async function fetchBodies(relPaths, opts = {}) {
    const list = (relPaths || []).filter((p) => typeof p === 'string' && p);
    if (!list.length) return { ok: true, rows: [] };
    const select = 'id,class,rel_path,sha256,size_bytes,body,body_encoding,updated_at,rev,deleted_at';
    const rows = [];
    for (let i = 0; i < list.length; i += page) {
      const slice = list.slice(i, i + page);
      // PostgREST `in.(…)`: virgül/parantez taşıyan değer TIRNAKLANMALI, yoksa
      // liste sessizce yanlış parçalanır (yol adında virgül meşrudur).
      const inList = slice.map((p) => `"${String(p).replace(/"/g, '\\"')}"`).join(',');
      const q = `/rest/v1/crewpane_files?${scopeFilter(opts.workspaceKey)}`
        + `&rel_path=in.(${encodeURIComponent(inList)})&select=${select}&limit=${page}`;
      const r = await request(q, { headers: headers() });
      if (!r.ok) return r;
      rows.push(...(Array.isArray(r.body) ? r.body : []));
    }
    return { ok: true, rows };
  }

  /**
   * UCUZ SİLME SONDASI (§2.5 "dosya sayısı beklenmedik biçimde ayrıştı").
   *
   * Tombstone perdesi silinen satırı GİZLEDİĞİ için delta silmeyi hiç görmez.
   * `count=exact` + `limit=0` sıfır gövde ile GÖRÜNÜR satır sayısını verir:
   * defterdekinden azsa uzakta bir silme olmuştur → mutabakat koşar.
   */
  async function countVisible(opts = {}) {
    const q = `/rest/v1/crewpane_files?${scopeFilter(opts.workspaceKey)}&select=id&limit=0`;
    const r = await request(q, { headers: headers({ Prefer: 'count=exact' }) });
    if (!r.ok) return r;
    const range = r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-range') : null;
    const total = range && range.includes('/') ? Number(range.split('/')[1]) : NaN;
    if (!Number.isFinite(total)) return { ok: false, kind: 'permanent', status: r.status, error: `content-range okunamadı: ${range}` };
    return { ok: true, count: total };
  }

  // ── YAZMA ────────────────────────────────────────────────────────────────────

  function rowPayload(file) {
    const row = {
      workspace_key: file.workspaceKey || workspaceKey,
      class: file.class,
      rel_path: file.relPath,
      sha256: file.sha256,
      size_bytes: file.size,
      body: file.body,
      body_encoding: file.encoding || 'utf8',
    };
    const companyId = currentCompanyId();
    if (companyId) row.company_id = companyId;
    if (deviceId) row.origin_device = deviceId;
    return row;
  }

  /** (a) INSERT dene. 409/23505 ⇒ `{kind:'duplicate'}` — çağıran PATCH'e geçer. */
  async function insertFile(file) {
    const r = await request('/rest/v1/crewpane_files', {
      method: 'POST',
      headers: headers({ Prefer: PREFER_REP }, 'POST'),
      body: JSON.stringify(rowPayload(file)),
    });
    if (!r.ok) return r;
    const row = Array.isArray(r.body) ? r.body[0] : r.body;
    return { ok: true, row };
  }

  /**
   * (b) KOŞULLU PATCH — `rev=eq.<base>`. 0 satır ⇒ `{ok:true, stale:true}`.
   *
   * ⚠️ `stale` bir HATA DEĞİLDİR, bir ÖLÇÜMDÜR: "temel aldığım sürüm artık güncel
   * değil". Çağıran satırı çeker, LWW uygular, `sync_conflicts` yazar. Bunu
   * hata saymak, çakışmayı bir yeniden-deneme döngüsüne çevirirdi.
   */
  async function patchFile(id, baseRev, file) {
    const q = `/rest/v1/crewpane_files?id=eq.${encode(id)}&rev=eq.${encode(baseRev)}`;
    const patch = rowPayload(file);
    delete patch.workspace_key; // kimlik kolonları PATCH'te DEĞİŞMEZ
    delete patch.class;
    delete patch.rel_path;
    delete patch.company_id;
    const r = await request(q, { method: 'PATCH', headers: headers({ Prefer: PREFER_REP }, 'PATCH'), body: JSON.stringify(patch) });
    if (!r.ok) return r;
    const rows = Array.isArray(r.body) ? r.body : [];
    if (rows.length === 0) return { ok: true, stale: true, row: null };
    return { ok: true, stale: false, row: rows[0] };
  }

  /** Tek satırı yolla çek (çakışma anında "güncel hâli ne?" sorusu). */
  async function getByRelPath(relPath, opts = {}) {
    const select = 'id,class,rel_path,sha256,size_bytes,body,body_encoding,updated_at,rev,deleted_at,origin_device';
    const q = `/rest/v1/crewpane_files?${scopeFilter(opts.workspaceKey)}`
      + `&rel_path=eq.${encode(relPath)}&select=${select}&limit=1`;
    const r = await request(q, { headers: headers() });
    if (!r.ok) return r;
    const rows = Array.isArray(r.body) ? r.body : [];
    return { ok: true, row: rows[0] || null };
  }

  /**
   * 🔴 SİLME — YALNIZ RPC (§1.6). Düz `PATCH deleted_at` ÖLÇÜLDÜ: 401/42501.
   * Buraya bir PATCH yolu eklemek, o 42501'i ürünün içine taşımaktır.
   */
  async function deleteFile(id, opts = {}) {
    const r = await request('/rest/v1/rpc/crewpane_file_tombstone', {
      method: 'POST',
      headers: headers({}, 'POST'),
      body: JSON.stringify({ p_file_id: id, p_restore: Boolean(opts.restore) }),
    });
    if (!r.ok) return r;
    // Fonksiyon `boolean` döner: `false` = satır bulunamadı ya da KİRACI NÖBETİ
    // reddetti. İkisi de sessizce başarı sayılamaz.
    return { ok: true, hit: r.body === true };
  }

  // ── ÇAKIŞMA DEFTERİ ──────────────────────────────────────────────────────────

  async function insertConflict(conflict) {
    const row = {
      workspace_key: conflict.workspaceKey || workspaceKey,
      rel_path: conflict.relPath,
      class: conflict.class,
      kind: conflict.kind || 'lww',
      winner_sha256: conflict.winnerSha || null,
      winner_rev: Number.isFinite(conflict.winnerRev) ? conflict.winnerRev : null,
      winner_device: conflict.winnerDevice || null,
      loser_sha256: conflict.loserSha || null,
      loser_rev: Number.isFinite(conflict.loserRev) ? conflict.loserRev : null,
      loser_device: conflict.loserDevice || deviceId,
      loser_body: conflict.loserBody == null ? null : conflict.loserBody,
      detail: conflict.detail || null,
    };
    const companyId = currentCompanyId();
    if (companyId) row.company_id = companyId;
    const r = await request('/rest/v1/sync_conflicts', {
      method: 'POST', headers: headers({ Prefer: PREFER_REP }, 'POST'), body: JSON.stringify(row),
    });
    if (!r.ok) return r;
    return { ok: true, row: Array.isArray(r.body) ? r.body[0] : r.body };
  }

  async function listConflicts(opts = {}) {
    const select = 'id,rel_path,class,kind,winner_sha256,winner_rev,winner_device,'
      + 'loser_sha256,loser_rev,loser_device,detail,detected_at,resolved_at,resolution';
    const open = opts.openOnly === false ? '' : '&resolved_at=is.null';
    const q = `/rest/v1/sync_conflicts?${scopeFilter(opts.workspaceKey)}${open}`
      + `&select=${select}&order=detected_at.desc&limit=${opts.limit || page}`;
    const r = await request(q, { headers: headers() });
    if (!r.ok) return r;
    return { ok: true, rows: Array.isArray(r.body) ? r.body : [] };
  }

  /** Kaybeden baytı geri almak için: gövde AYRI çekilir (liste sorgusunu şişirmesin). */
  async function getConflictBody(id) {
    const q = `/rest/v1/sync_conflicts?id=eq.${encode(id)}&select=id,rel_path,class,loser_sha256,loser_body&limit=1`;
    const r = await request(q, { headers: headers() });
    if (!r.ok) return r;
    const rows = Array.isArray(r.body) ? r.body : [];
    return { ok: true, row: rows[0] || null };
  }

  async function resolveConflict(id, resolution) {
    const q = `/rest/v1/sync_conflicts?id=eq.${encode(id)}`;
    const r = await request(q, {
      method: 'PATCH', headers: headers({ Prefer: PREFER_REP }, 'PATCH'),
      body: JSON.stringify({ resolved_at: new Date().toISOString(), resolution }),
    });
    if (!r.ok) return r;
    const rows = Array.isArray(r.body) ? r.body : [];
    return { ok: true, row: rows[0] || null };
  }

  // ── ÇALIŞMA ALANI DEFTERİ (§1.2) ────────────────────────────────────────────

  async function listWorkspaces() {
    const q = `/rest/v1/crewpane_workspaces?${tenantFilter()}`
      + '&select=id,workspace_key,display_name,created_device,updated_at&order=updated_at.desc&limit=100';
    const r = await request(q, { headers: headers() });
    if (!r.ok) return r;
    return { ok: true, rows: Array.isArray(r.body) ? r.body : [] };
  }

  async function registerWorkspace(key, displayName) {
    const row = { workspace_key: key, display_name: displayName };
    const companyId = currentCompanyId();
    if (companyId) row.company_id = companyId;
    if (deviceId) row.created_device = deviceId;
    const r = await request('/rest/v1/crewpane_workspaces', {
      method: 'POST', headers: headers({ Prefer: PREFER_REP }, 'POST'), body: JSON.stringify(row),
    });
    // Zaten kayıtlı olması HATA DEĞİLDİR: ikinci cihaz aynı anahtarı seçmiştir.
    if (!r.ok && r.kind === 'duplicate') return { ok: true, row: null, existed: true };
    if (!r.ok) return r;
    return { ok: true, row: Array.isArray(r.body) ? r.body[0] : r.body, existed: false };
  }

  return {
    listManifest,
    listDelta,
    fetchBodies,
    countVisible,
    insertFile,
    patchFile,
    getByRelPath,
    deleteFile,
    insertConflict,
    listConflicts,
    getConflictBody,
    resolveConflict,
    listWorkspaces,
    registerWorkspace,
    workspaceKey,
    /** Anlık kiracı (canlı okuma) — kuruluş anındaki değer DEĞİL. */
    companyId: currentCompanyId,
    deviceId,
  };
}

module.exports = { createSyncClient, classifyStatus, classifyResponse, PAGE };
