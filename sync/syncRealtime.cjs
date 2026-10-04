// SYNC-F1-3 (Wheeljack) — REALTIME: "bir şey değişti" bildirimi. Veri DEĞİL.
//                         Tasarım: SYNC-F1-TASARIM.md §1.5 · §2.5 · OFS-01 dersi
//
// ═══════════════════════════════════════════════════════════════════════════════
// 🔴 OLAYIN PAYLOAD'INA GÜVENİP DOSYA YAZILMAZ — TEK CÜMLELİK KURAL
// ═══════════════════════════════════════════════════════════════════════════════
// Publication KOLON LİSTESİ `body`yi WAL'e sokmuyor (§1.5, PG 17.6'da ölçüldü), yani
// payload'da gövde ZATEN yok. Ama kural bundan daha güçlü tutulur: payload gelse bile
// KULLANILMAZ. Gerekçe üç katlı —
//   1. Realtime EN AZ BİR KEZ teslim eder; sırayı garanti etmez. İki hızlı yazımın
//      olayları ters sırada gelirse payload'a güvenen istemci ESKİ baytı yazar.
//   2. Free planın broadcast tavanı 256 KB; tavana dayanan olay SESSİZCE düşer —
//      "olay geldi = veri geldi" varsayımı o an sessiz veri kaybına döner.
//   3. Kolon listesi bir gün gevşetilirse (yeni bir migration, bir insan hatası)
//      gövde kanaldan akmaya başlar ve İSTEMCİ BUNU FARK ETMEZ.
// Olay yalnız bir ZİLdir: `onNotify()` -> motor `pull()` planlar, gerçeği
// PostgREST'ten okur.
//
// ─────────────────────────────────────────────────────────────────────────────
// OFS-01: SUBSCRIBED != CANLI
// ─────────────────────────────────────────────────────────────────────────────
// Ölçülmüş arıza: tablo publication'da yokken kanal `SUBSCRIBED` döner ama TEK OLAY
// GELMEZ. `realtimeProven(subscribed, eventsSeen)` bu yüzden olay SAYISINA bakar;
// kanıt gelene kadar yedek poll SEYRELTİLMEZ (5 sn), kanıt gelince 60 sn'ye çıkar.
// Tersi ölçülmüş bedeldir: tek canlılık kanalı, tam da realtime hiç çalışmadığı
// ortamda YAVAŞLAR.
//
// Saf değil ama TAM DI: `createClient` enjekte edilir -> `node --test` ağsız koşar.

'use strict';

const Delta = require('./deltaCore.cjs');

/** Olaydan sonra `pull()` planlanmadan önce beklenen süre (§2.5: 500 ms, tek uçuş). */
const NOTIFY_DEBOUNCE_MS = 500;

/** Kanal adı — workspace başına AYRI kanal (bir workspace'in gürültüsü diğerine gitmesin). */
function channelNameFor(workspaceKey) {
  return `syncf1:files:${workspaceKey}`;
}

/**
 * Payload'da gövde var mı? Varsa bu bir KOLON LİSTESİ GERİLEMESİdir ve GÖRÜNÜR olmalı.
 * (Kural gereği payload zaten kullanılmıyor; bu nöbet sessiz bir şema kaymasını yakalar.)
 */
function payloadCarriesBody(payload) {
  const rec = payload && (payload.new || payload.old);
  if (!rec || typeof rec !== 'object') return false;
  return Object.prototype.hasOwnProperty.call(rec, 'body')
    || Object.prototype.hasOwnProperty.call(rec, 'storage_path');
}

/**
 * @param {{url:string, key:string, workspaceKey:string, companyId?:string|null,
 *          createClient?:Function, onNotify:Function, onStatus?:Function,
 *          log?:Function, setTimer?:Function, clearTimer?:Function,
 *          debounceMs?:number}} deps
 */
function createSyncRealtime(deps = {}) {
  const url = deps.url;
  const key = deps.key;
  const workspaceKey = deps.workspaceKey;
  const companyId = deps.companyId == null ? null : String(deps.companyId);
  const createClient = typeof deps.createClient === 'function' ? deps.createClient : null;
  const onNotify = typeof deps.onNotify === 'function' ? deps.onNotify : () => {};
  const onStatus = typeof deps.onStatus === 'function' ? deps.onStatus : () => {};
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : setTimeout;
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : clearTimeout;
  const debounceMs = Number.isFinite(deps.debounceMs) ? deps.debounceMs : NOTIFY_DEBOUNCE_MS;

  let client = null;
  let channel = null;
  let subscribed = false;
  let eventsSeen = 0;
  let timer = null;
  let closed = false;
  let bodyLeakSeen = false;

  function proven() {
    return Delta.realtimeProven(subscribed, eventsSeen);
  }

  function emitStatus() {
    try {
      onStatus({ subscribed, eventsSeen, realtimeProven: proven(), bodyLeakSeen });
    } catch { /* dinleyici hatası kanalı düşürmez */ }
  }

  function scheduleNotify(reason) {
    if (closed) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      try { onNotify({ reason, eventsSeen }); } catch (err) { log(`[sync-rt] onNotify hatası: ${err.message}`); }
    }, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /** Olay geldi. Payload OKUNMAZ — yalnız SAYILIR ve bir zil çalar. */
  function handleEvent(payload) {
    eventsSeen += 1;
    if (!bodyLeakSeen && payloadCarriesBody(payload)) {
      bodyLeakSeen = true;
      // GERİLEME UYARISI: §1.5'in kolon listesi gevşemiş demektir. Ürün çalışmaya
      // devam eder (payload zaten kullanılmıyor) ama bu sessiz kalmamalı.
      log('[sync-rt] UYARI: realtime payload gövde kolonu taşıyor — publication kolon listesi gerilemiş (§1.5)');
    }
    emitStatus();
    scheduleNotify('realtime');
    return { eventsSeen, realtimeProven: proven() };
  }

  function handleSubscribe(status) {
    subscribed = status === 'SUBSCRIBED';
    if (!subscribed && status) log(`[sync-rt] kanal durumu: ${status}`);
    emitStatus();
    return { subscribed, realtimeProven: proven() };
  }

  function start() {
    if (channel) return { ok: true, already: true };
    if (!createClient) return { ok: false, reason: 'no-createClient' };
    if (!url || !key || !workspaceKey) return { ok: false, reason: 'missing-target' };
    try {
      client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
      // Abonelik SÜZGECİ workspace'tir. `company_id` süzgeci EKLENMEZ: RLS zaten her
      // aboneye kiracı policy'sini uygular ve iki süzgeç birden, `company_id` NULL
      // olan (tek kullanıcılı yerel) kurulumda HİÇ olay getirmezdi.
      channel = client.channel(channelNameFor(workspaceKey));
      channel.on('postgres_changes', {
        event: '*', schema: 'public', table: 'crewpane_files',
        filter: `workspace_key=eq.${workspaceKey}`,
      }, handleEvent);
      channel.subscribe(handleSubscribe);
    } catch (err) {
      log(`[sync-rt] kanal kurulamadı: ${err.message}`);
      return { ok: false, reason: 'subscribe-failed', error: String(err.message) };
    }
    return { ok: true, channel: channelNameFor(workspaceKey), companyScope: companyId };
  }

  async function stop() {
    closed = true;
    if (timer) { clearTimer(timer); timer = null; }
    try { if (channel && client && typeof client.removeChannel === 'function') await client.removeChannel(channel); } catch { /* kapanış sessiz */ }
    channel = null;
    client = null;
    subscribed = false;
    emitStatus();
  }

  return {
    start, stop, handleEvent, handleSubscribe,
    status: () => ({ subscribed, eventsSeen, realtimeProven: proven(), bodyLeakSeen }),
    pollMs: (fast, slow) => Delta.backupPollMs(proven(), fast, slow),
    channelName: () => channelNameFor(workspaceKey),
  };
}

module.exports = { createSyncRealtime, channelNameFor, payloadCarriesBody, NOTIFY_DEBOUNCE_MS };
