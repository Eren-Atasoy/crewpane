// ADP-845 (Ratchet) — GÜNLÜK HEARTBEAT: "kim, hangi sürümde, ne zaman aktifti".
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN VAR
// ─────────────────────────────────────────────────────────────────────────────
// ADP-805 ölçtü: bugün müşteri hakkında hiçbir şey bilmiyoruz — uygulama açıldı
// mı, hangi sürüm kurulu, güncelleme feed'i ona ulaşıyor mu. Bu modül o boşluğun
// TEK gönderim yolu. Tasarım ADP-805 §3.4 birebir.
//
// ─────────────────────────────────────────────────────────────────────────────
// SÖZLEŞME (pazarlıksız)
// ─────────────────────────────────────────────────────────────────────────────
// 1. OPT-OUT KAPISI EN BAŞTA. `enabled()` false ise TEK BİR fetch bile çıkmaz —
//    hedef çözümü, jeton alımı, şirket sorgusu HİÇBİRİ çalışmaz. (Kapıyı sona
//    koymak "kapalıyken de ağ trafiği var" demek olurdu; test bunu ölçer.)
// 2. İÇERİK ASLA GİTMEZ. Giden gövde `buildPayload` çıktısıdır ve o fonksiyon
//    SABİT bir alan listesi üretir; çağıranın verdiği fazladan alan DÜŞER.
//    Sayaçlar beyaz-listelidir ve yalnız SAYI taşır (ADP-805 §5).
// 3. ASLA THROW ETMEZ, ASLA KULLANICIYA GÖRÜNMEZ, ASLA RETRY FIRTINASI YAPMAZ.
//    Telemetri bir yan etkidir; uygulamayı yavaşlatması/düşürmesi yasaktır.
// 4. Giriş yapmamış kullanıcıya heartbeat YOK (jeton yok → RLS yazdırmaz).
//    Anonim uç bilerek YOKTUR (ADP-845 K4).
//
// TÜM IO ENJEKTE (fetch + hedef + jeton + ayarlar + saat) → `node --test` doğrudan
// koşar, Electron gerekmez.
//   node --test electron/telemetry/heartbeat.test.cjs

'use strict';

const appDbIdentity = require('../src/config/appDbIdentity.cjs');

const REQUEST_TIMEOUT_MS = 10_000;
/** Günlük heartbeat — ADP-805 §3.4(b). */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Açılışın kritik yolu ile yarışmasın (updater ile aynı nezaket). */
const DEFAULT_STARTUP_DELAY_MS = 8_000;

/**
 * SAYAÇ BEYAZ LİSTESİ — migration'daki `app_installs_counters_whitelist` CHECK
 * kısıtıyla AYNI küme olmak ZORUNDA. Buraya yeni bir anahtar eklemek migration
 * ister; böylece "sayaç adı bir gün ajan/dosya ADINA dönüşür" riski yapısal
 * olarak kapalı kalır (ADP-805 §5.12).
 */
const COUNTER_KEYS = Object.freeze([
  'panes_opened',
  'agents_spawned',
  'tasks_created',
  'delegations',
  'memory_writes',
  'voice_seconds',
]);

/** Güncelleme kontrolünün BİLİNEN sonuçları — serbest metin DEĞİL. */
const UPDATE_RESULTS = Object.freeze([
  'ok', 'no-update', 'http-403', 'network', 'timeout', 'bad-payload', 'error',
]);

/** Kısa metin alanı temizleyici: yalnız güvenli karakter + sert uzunluk sınırı. */
function shortText(value, max) {
  if (typeof value !== 'string') return null;
  const v = value.trim().replace(/[^\w.\-+]/g, '').slice(0, max || 32);
  return v || null;
}

/** uuid mi? (install_id / user_id / company_id — başka hiçbir şey kabul edilmez) */
function asUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

/**
 * JWT'nin `sub` claim'i = kullanıcı id'si. İMZA DOĞRULANMAZ ve doğrulanmasına
 * GEREK YOKTUR: bu değer yalnız bizim gövdemizi doldurur, yetki kararı vermez —
 * son sözü RLS (`auth.uid()`) söyler. Çözülemezse null döner ve alan hiç
 * gönderilmez (kolon `default auth.uid()` ile dolar).
 */
function userIdFromToken(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const json = Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return asUuid(JSON.parse(json).sub);
  } catch {
    return null;
  }
}

/**
 * KABA SAYAÇ defteri. Anahtar beyaz listede değilse SESSİZCE DÜŞER (çağıranın
 * hatası telemetriyi içerik kanalına çeviremesin).
 */
function createCounters(initial) {
  const store = Object.create(null);
  for (const k of COUNTER_KEYS) {
    const v = initial && Number(initial[k]);
    store[k] = Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }
  return {
    bump(key, by) {
      if (!COUNTER_KEYS.includes(key)) return false; // beyaz liste dışı → YOK sayılır
      const n = Number.isFinite(Number(by)) ? Math.floor(Number(by)) : 1;
      if (n <= 0) return false;
      store[key] += n;
      return true;
    },
    /** Yalnız SIFIRDAN BÜYÜK sayaçlar — boş alan göndermeyiz. */
    snapshot() {
      const out = {};
      for (const k of COUNTER_KEYS) if (store[k] > 0) out[k] = store[k];
      return out;
    },
    reset() { for (const k of COUNTER_KEYS) store[k] = 0; },
  };
}

/**
 * GİDEN GÖVDE — tek gerçek. Alan listesi BURADA SABİTTİR; girdide ne olursa
 * olsun başka bir alan çıkışa geçemez (whitelist-by-construction).
 *
 * @returns {object|null} zorunlu alanlar eksikse null (gönderim yapılmaz)
 */
function buildPayload(input) {
  const i = input || {};
  const installId = asUuid(i.installId);
  const userId = asUuid(i.userId);
  const app = shortText(i.app, 32);
  const version = shortText(i.appVersion, 32);
  const buildChannel = shortText(i.buildChannel, 16);
  const platform = shortText(i.platform, 16);
  if (!installId || !app || !version || !buildChannel || !platform) return null;

  const counters = {};
  const rawCounters = i.counters && typeof i.counters === 'object' ? i.counters : {};
  for (const k of COUNTER_KEYS) {
    const v = Number(rawCounters[k]);
    if (Number.isFinite(v) && v > 0) counters[k] = Math.floor(v);
  }

  const updateResult = UPDATE_RESULTS.includes(i.updateResult) ? i.updateResult : null;

  const body = {
    install_id: installId,
    // `user_id` çözülemediyse ANAHTAR HİÇ KONMAZ: kolonun `default auth.uid()`
    // değeri doldurur (migration §1). Boş/yanlış bir uuid göndermek RLS'i
    // 42501'le kırardı ve sebebi görünmezdi (ADP-840 dersi).
    ...(userId ? { user_id: userId } : {}),
    app,
    app_version: version,
    build_channel: buildChannel,
    platform,
    last_seen_at: new Date(Number.isFinite(i.now) ? i.now : Date.now()).toISOString(),
    days_seen: Math.max(1, Math.floor(Number(i.daysSeen) || 1)),
    sessions: Math.max(1, Math.floor(Number(i.sessions) || 1)),
    counters,
  };

  // ⚠️ BİLİNMEYEN ALAN GÖNDERİLMEZ (ölçülmüş kusur): upsert `merge-duplicates`
  // gövdedeki HER kolonu yazar. Bu alanları `null` ile göndermek, DÜN ölçülmüş
  // bir gerçeği (ör. "güncelleme feed'i 403 veriyor") bugünkü heartbeat'in
  // SESSİZCE SİLMESİ demekti — uygulama yeniden başladığında bellekteki sonuç
  // sıfırlandığı için tam da bu oluyordu. Anahtarı hiç koymayınca upsert eski
  // değeri KORUR.
  const optional = {
    company_id: asUuid(i.companyId),
    update_channel: shortText(i.updateChannel, 16),
    updater_mode: shortText(i.updaterMode, 16),
    os_release: shortText(i.osRelease, 64),
    arch: shortText(i.arch, 16),
    ui_locale: shortText(i.uiLocale, 16),
    update_last_check_at: Number.isFinite(i.updateCheckedAt) ? new Date(i.updateCheckedAt).toISOString() : null,
    update_last_result: updateResult,
    update_latest_seen: shortText(i.updateLatestSeen, 32),
  };
  for (const [k, v] of Object.entries(optional)) if (v !== null) body[k] = v;

  // ⚠️ `first_seen_at` de BİLEREK GÖNDERİLMEZ: ilk görülme damgası sonraki
  // heartbeat'lerde KORUNUR. Gövdeye eklenirse her gün "ilk kez görüldü" olurdu.
  return body;
}

/**
 * Heartbeat gönderici.
 *
 * deps:
 *   enabled()      → boolean   OPT-OUT kapısı (settings.telemetryEnabled + kill-switch)
 *   target()       → {url, anonKey, schema} | null
 *   accessToken()  → Promise<{ok,token}|string|null>
 *   state()        → {installId, sessions, daysSeen, lastDay}   kalıcı sayaçlar
 *   saveState(patch)→ void
 *   info()         → {app, appVersion, buildChannel, updateChannel, updaterMode,
 *                     platform, osRelease, arch, uiLocale}
 *   fetchImpl, log, now, intervalMs, startupDelayMs
 */
function createHeartbeat(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  const doFetch = d.fetchImpl || ((...a) => globalThis.fetch(...a));
  const now = d.now || (() => Date.now());
  const intervalMs = Number.isFinite(d.intervalMs) && d.intervalMs > 0 ? d.intervalMs : DEFAULT_INTERVAL_MS;
  const startupDelayMs = Number.isFinite(d.startupDelayMs) ? d.startupDelayMs : DEFAULT_STARTUP_DELAY_MS;
  const counters = createCounters();

  let timers = [];
  let lastUpdate = { result: null, checkedAt: null, latestSeen: null };
  let sending = false;

  function resolveTarget() {
    try {
      const t = typeof d.target === 'function' ? d.target() : d.target;
      if (!t || !t.url || !(t.anonKey || t.key)) return null;
      return { url: String(t.url).replace(/\/+$/, ''), key: t.anonKey || t.key, schema: t.schema || 'public' };
    } catch {
      return null;
    }
  }

  async function resolveToken() {
    if (typeof d.accessToken !== 'function') return null;
    try {
      const r = await d.accessToken();
      if (typeof r === 'string') return r || null;
      return r && r.ok && typeof r.token === 'string' && r.token ? r.token : null;
    } catch {
      return null;
    }
  }

  function headers(target, token, method) {
    return {
      apikey: target.key,
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      // ⚠️ `app` şeması başlığı ŞART. Taşınmazsa istek sessizce `public`e gider ve
      // 404/PGRST202 döner (ADP-773'te ölçülen sınıf hata). Elle yazılmaz —
      // kararı appDbIdentity verir.
      ...appDbIdentity.schemaHeaders(target.schema, method),
    };
  }

  /**
   * Aktif şirket — ADP-805 §12.4: kullanım ŞİRKETE bağlanmalı (ödeyen hesap
   * şirketin sahibi olmayabilir). Renderer'ın CompanyProvider'ı ile AYNI kural:
   * RLS'in gösterdiği EN ESKİ şirket. Hata → null (kolon nullable).
   */
  async function resolveCompanyId(target, token) {
    try {
      const res = await doFetch(
        `${target.url}/rest/v1/companies?select=id&order=created_at.asc&limit=1`,
        { method: 'GET', headers: headers(target, token, 'GET'), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const rows = await res.json();
      return Array.isArray(rows) && rows[0] ? asUuid(rows[0].id) : null;
    } catch {
      return null;
    }
  }

  /** Yerel gün damgası (YYYY-MM-DD) — `days_seen` bunun değişimiyle artar. */
  function dayKey(ts) {
    const dt = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
  }

  /**
   * Tek heartbeat. ASLA throw etmez.
   * @returns {Promise<{ok:boolean, action:string, status?:number}>}
   */
  async function send(reason) {
    // ── KAPI 1: OPT-OUT. Buradan önce HİÇBİR ağ çağrısı yoktur. ──────────────
    let on = true;
    try { on = typeof d.enabled === 'function' ? d.enabled() !== false : true; } catch { on = false; }
    if (!on) return { ok: false, action: 'opt-out' };

    if (sending) return { ok: false, action: 'busy' };
    sending = true;
    try {
      const target = resolveTarget();
      if (!target) return { ok: false, action: 'unconfigured' };
      const token = await resolveToken();
      // KAPI 2: kimlik yoksa gönderim YOK (anonim uç bilerek yok — K4).
      if (!token) return { ok: false, action: 'no-identity' };

      const state = (typeof d.state === 'function' ? d.state() : d.state) || {};
      const installId = asUuid(state.installId);
      if (!installId) return { ok: false, action: 'no-install-id' };

      const info = (typeof d.info === 'function' ? d.info() : d.info) || {};
      const userId = asUuid(info.userId) || userIdFromToken(token);
      const companyId = await resolveCompanyId(target, token);

      const today = dayKey(now());
      const daysSeen = state.lastDay === today
        ? Math.max(1, Number(state.daysSeen) || 1)
        : Math.max(1, Number(state.daysSeen) || 0) + (state.lastDay ? 1 : 0);

      // SAYAÇLAR KÜMÜLATİF (ölçülmüş kusur): upsert satırdaki `counters`ı EZER.
      // Bellekteki sayaç yalnız BU oturumu bilir; ezme sonrası satır "dün ne
      // yaptı"yı kaybederdi ve sayı her gün küçülüp büyürdü. Toplam = diskteki
      // son gönderilen + bu oturumun deltası; başarılı gönderimden sonra delta
      // diske yazılır ve bellek sıfırlanır (aynı artış iki kez sayılmaz).
      const persisted = state.counters && typeof state.counters === 'object' ? state.counters : {};
      const delta = counters.snapshot();
      const total = {};
      for (const k of COUNTER_KEYS) {
        const sum = (Number(persisted[k]) || 0) + (Number(delta[k]) || 0);
        if (sum > 0) total[k] = Math.floor(sum);
      }

      const body = buildPayload({
        installId,
        userId,
        companyId,
        app: info.app,
        appVersion: info.appVersion,
        buildChannel: info.buildChannel,
        updateChannel: info.updateChannel,
        updaterMode: info.updaterMode,
        platform: info.platform,
        osRelease: info.osRelease,
        arch: info.arch,
        uiLocale: info.uiLocale,
        daysSeen,
        sessions: Math.max(1, Number(state.sessions) || 1),
        counters: total,
        updateResult: lastUpdate.result,
        updateCheckedAt: lastUpdate.checkedAt,
        updateLatestSeen: lastUpdate.latestSeen,
        now: now(),
      });
      if (!body) return { ok: false, action: 'incomplete' };

      let res;
      try {
        res = await doFetch(`${target.url}/rest/v1/app_installs?on_conflict=install_id`, {
          method: 'POST',
          headers: { ...headers(target, token, 'POST'), prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Ağ hatası SESSİZ: tek deneme, sonraki periyot. Retry fırtınası YOK.
        log(`telemetry: heartbeat ulaşmadı (${reason}) — ${(err && err.message) || err}`);
        return { ok: false, action: 'unreachable' };
      }
      if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()).slice(0, 200); } catch { /* gövdesiz */ }
        log(`telemetry: heartbeat reddedildi (${reason}) HTTP ${res.status} ${detail}`);
        return { ok: false, action: 'rejected', status: res.status };
      }

      if (typeof d.saveState === 'function') {
        try { d.saveState({ daysSeen, lastDay: today, counters: total }); } catch { /* ayar yazılamadı = sorun değil */ }
      }
      counters.reset(); // delta diske geçti — ikinci kez sayılmasın
      log(`telemetry: heartbeat gönderildi (${reason}) v${body.app_version}/${body.build_channel}`);
      return { ok: true, action: 'sent', status: res.status };
    } finally {
      sending = false;
    }
  }

  return {
    /** Güncelleme kontrolünün SONUCU (serbest metin değil, sabit küme). */
    noteUpdate({ result, checkedAt, latestSeen } = {}) {
      if (UPDATE_RESULTS.includes(result)) lastUpdate.result = result;
      if (Number.isFinite(checkedAt)) lastUpdate.checkedAt = checkedAt;
      const v = shortText(latestSeen, 32);
      if (v) lastUpdate.latestSeen = v;
    },
    bump: (key, by) => counters.bump(key, by),
    counters: () => counters.snapshot(),
    send,
    start() {
      if (timers.length) return;
      const t1 = setTimeout(() => { send('startup').catch(() => {}); }, startupDelayMs);
      const t2 = setInterval(() => { send('daily').catch(() => {}); }, intervalMs);
      t1.unref?.(); t2.unref?.();
      timers = [t1, t2];
    },
    stop() {
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      timers = [];
    },
  };
}

module.exports = {
  COUNTER_KEYS,
  UPDATE_RESULTS,
  DEFAULT_INTERVAL_MS,
  createCounters,
  buildPayload,
  createHeartbeat,
  userIdFromToken,
};
