// ADP-334 — /m/office'in MAIN süreçteki üreticisi (ADR-023 · mobil dalga-2).
//
// SORUN: ofis verisi renderer'da derleniyordu (`mobile:query` → mobileBridgeClient
// .buildOffice). Uygulama penceresi kapandığında renderer YOK → telefon ofisi hiç
// göremiyordu (503 "uygulama penceresi cevap vermedi"). Mobil kullanımın temel şartı
// bunun tersi: Mac'te pencere kapalı olsa bile telefon ÇALIŞSIN. ADP-317'de Jarvis
// defteri aynı gerekçeyle main'e taşınmıştı; bu modül ofisin aynısını yapar.
//
// KAYNAKLAR (hepsi main'de erişilebilir — renderer'a hiç sorulmaz):
//   • roster + sprite  → Supabase PostgREST (anon key; renderer'ın okuduğu AYNI tablolar)
//   • pane'ler         → main'in canlı pty defteri (listPanes DI)
//   • delegasyon       → `delegationState()` DI. Pencere AÇIKSA renderer'ın canlı
//                        motorundan (tek gerçek kaynak orada), KAPALIYSA main'in
//                        diskteki delegasyon kuyruğundan (delegationQueueStore).
//                        Pencere kapalıyken uçuşta delegasyon OLAMAZ: pane'leri zaten
//                        öldürülür ve motor renderer-ömürlüdür → active:0 dürüsttür.
//
// Bu modül İŞ MANTIĞI icat etmez: statü/alert eşlemesi renderer'daki buildOffice'ten
// birebir taşındı (tek kopya kaldı; renderer artık yalnız delegasyon durumunu verir).

'use strict';

const appDbIdentity = require('../config/appDbIdentity.cjs');

const SUPABASE_TIMEOUT_MS = 5000;

/** Uçuşta sayılan subtask statüleri (renderer agentStatusFrom ile birebir). */
const WORKING_STATUSES = Object.freeze(['dispatched', 'working', 'review']);

/**
 * Delegasyon anlık durumu → ajan başına statü/görev (ilk eşleşen kazanır; paused
 * öncelikli — renderer'daki sıra korunur).
 * @param {Array<{agentId: string, status: 'working'|'paused', title?: string|null}>} assignments
 */
function assignmentFor(agentId, assignments) {
  let working = null;
  for (const a of assignments || []) {
    if (!a || a.agentId !== agentId) continue;
    if (a.status === 'paused') return { status: 'paused', currentTask: a.title ?? null };
    if (!working && a.status === 'working') working = { status: 'working', currentTask: a.title ?? null };
  }
  return working || { status: 'idle', currentTask: null };
}

/**
 * Ofis anlık görüntüsünü PARÇALARDAN kur (saf — I/O yok, test edilebilir).
 *
 * @param {object} p
 * @param {Array<{id:string, display_name:string, department?:string|null, role?:string|null}>} p.agents
 * @param {Map<string,string>|null} p.sprites       agentId → sprite key
 * @param {Array<{paneId:string, agentId?:string|null}>} p.panes
 * @param {{assignments?:Array, active?:number, queued?:number}} p.delegation
 */
function officeFromParts({ agents, sprites, panes, delegation }) {
  const dlg = delegation || {};
  const assignments = Array.isArray(dlg.assignments) ? dlg.assignments : [];
  const paneList = Array.isArray(panes) ? panes : [];
  const spriteMap = sprites instanceof Map ? sprites : new Map();

  const alerts = [];
  let paused = 0;

  const out = (agents || []).map((a) => {
    // ADP-948 — bir ajanın BİRDEN ÇOK pane'i olabilir; herhangi biri çıktı üretiyorsa
    // o ajan çalışıyordur (masaüstü `usePaneRuntime` ile AYNI indirgeme).
    const agentPanes = paneList.filter((p) => p && p.agentId === a.id);
    // MOB-PANE-MAP-01 (FB-1013) — eşleme 1:1 DEĞİL N:1: telefon eskiden yalnız
    // `agentPanes[0]`ı görüyordu, ajanın ikinci pane'i telefonda AJANSIZ kalıyor ve
    // Gönder sessizce kapanıyordu. Artık pane'lerin TAMAMI gider (`paneIds`, defter
    // sırası); `paneId` ise AKTİF pane'dir — çıktı üreten varsa o, yoksa ilki
    // (kararlı: hepsi susuyorsa seçim zıplamaz). Ofis ekranındaki "terminalini aç"
    // dokunuşu ve eski istemciler `paneId`yi okumaya devam eder.
    const pane = agentPanes.find((p) => p.status === 'working') || agentPanes[0] || null;
    const paneWorking = agentPanes.some((p) => p.status === 'working');
    const { status, currentTask } = assignmentFor(a.id, assignments);
    let st = status;
    // ADP-948 — DURUM YALNIZ DELEGASYONDAN TÜRETİLİYORDU: lider tarafından doğrudan
    // açılan (delegasyonsuz) bir pane saatlerce iş yapsa bile telefon "boşta" diyordu
    // (müşteri Çınar, IMG_0086/0087 — "0 çalışıyor"). Canlı pty aktivitesi
    // (`agentRunner.statusFor` → listPanes().status) zaten elimizde; artık okunuyor.
    // Öncelik: delegasyon 'paused' (limitte) > canlı pane > delegasyon 'working'.
    if (status === 'idle') {
      if (paneWorking) st = 'working';
      else if (!pane) st = 'offline';
    }
    if (status === 'paused') {
      paused++;
      alerts.push({
        kind: 'limit',
        agentId: a.id,
        message: `${a.display_name} limitte — resetAt'te otomatik devam eder`,
        at: Date.now(),
      });
    }
    return {
      agentId: a.id,
      displayName: a.display_name,
      department: a.department ?? null,
      role: a.role ?? null,
      paneId: pane ? pane.paneId : null,
      paneIds: agentPanes.map((p) => p.paneId),
      status: st,
      currentTask,
      sprite: spriteMap.get(a.id) ?? null, // ADP-313 — masaüstüyle AYNI pixel kimlik
    };
  });

  const queued = Number(dlg.queued) || 0;
  if (queued > 0) {
    alerts.push({ kind: 'queued', agentId: null, message: `${queued} delegasyon kuyrukta bekliyor`, at: Date.now() });
  }

  return {
    agents: out,
    delegations: { active: Number(dlg.active) || 0, queued, paused },
    alerts,
  };
}

/**
 * ADP-773 — PostgREST hatasını İNSANCA anlat.
 *
 * Eskisi "Supabase agents: HTTP 404" idi: ne olduğunu da ne yapılacağını da söylemiyordu.
 * Telefondaki kullanıcı Mac'in başında değil — mesaj hem SEBEBİ hem ELDEKİ ADIMI taşımalı.
 * Ham durum/kod mesajın SONUNDA kalır (destek için teşhis değeri kaybolmasın).
 */
function describeRestFailure({ table, status, schema, body, authed }) {
  const where = `${schema || 'public'}.${table}`;
  const code = body && typeof body.code === 'string' ? body.code : '';
  const detail = `[${where} · HTTP ${status}${code ? ` · ${code}` : ''}]`;

  // Tablo bulunamadı: neredeyse her zaman şema/isim kayması (bkz. mobileBackendRead.test.cjs).
  if (status === 404 || code === 'PGRST205') {
    return `veritabanında '${where}' tablosu yok — mobil istek yanlış şemaya düşmüş ya da tablo `
      + `yeniden adlandırılmış olabilir. Mac'teki CrewPane'i güncelleyip yeniden başlatın; `
      + `sorun sürerse bu satırı desteğe iletin ${detail}`;
  }
  // Yetki: `app` şemasını anon rolü okuyamaz (ADP-623) → oturum gerekiyor.
  if (status === 401 || status === 403 || code === '42501') {
    return authed
      ? `bu hesabın '${where}' verisine erişim yetkisi yok — paketiniz/koltuğunuz aktif mi diye `
        + `Mac'teki CrewPane → Ayarlar → Hesap ekranından bakın ${detail}`
      : `Mac'teki CrewPane'te CrewPane ID oturumu açık değil (telefon Mac'in kimliğiyle okur). `
        + `Mac'te oturum açıp telefonda sayfayı yenileyin ${detail}`;
  }
  if (status >= 500) {
    return `veritabanı sunucusu şu an cevap veremiyor — birkaç dakika sonra tekrar deneyin ${detail}`;
  }
  return `'${where}' okunamadı ${detail}`;
}

/**
 * PostgREST GET — satır dizisi döndürür; hata FIRLATIR (gateway 502'ye çevirir).
 *
 * ADP-773 — İSTEK MASAÜSTÜYLE AYNI ÜÇ ŞEYİ TAŞIR (üçü de hedefle birlikte gelir,
 * burada İKİNCİ KEZ sabitlenmez):
 *   • url + apikey  → anon (publishable) anahtar; PostgREST/Kong bunu ister
 *   • accept-profile → `supabase.schema` (bulut 'app', yerel/e2e 'public'). Başlık
 *     appDbIdentity.schemaHeaders ile üretilir — masaüstü ve görev MCP'siyle AYNI kaynak.
 *   • authorization → varsa kullanıcının TAZE jetonu, yoksa anon anahtar (bugünkü davranış).
 *     `app` şemasında anon rolü revoke edilmiştir → bulutta jeton ZORUNLUDUR.
 */
async function selectRows(supabase, table, columns, fetchImpl, token) {
  if (!supabase || !supabase.url || !supabase.key) throw new Error('Supabase yapılandırılmamış');
  const doFetch = fetchImpl || globalThis.fetch;
  const url = `${String(supabase.url).replace(/\/+$/, '')}/rest/v1/${table}?select=${encodeURIComponent(columns)}`;
  const res = await doFetch(url, {
    headers: {
      apikey: supabase.key,
      authorization: `Bearer ${token || supabase.key}`,
      accept: 'application/json',
      ...appDbIdentity.schemaHeaders(supabase.schema, 'GET'),
    },
    signal: AbortSignal.timeout(SUPABASE_TIMEOUT_MS),
  });
  if (!res.ok) {
    let body = null;
    try { body = await res.json(); } catch { /* gövde JSON değil → yalnız durum kodu */ }
    throw new Error(describeRestFailure({
      table, status: res.status, schema: supabase.schema, body, authed: !!token,
    }));
  }
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

/**
 * Kullanıcının TAZE app-DB jetonu (main'deki seatGate → `appdb:token` ile AYNI kaynak).
 * `null` bir hata değil bir DURUM: yerel/e2e stack'te kimlik yoktur, istek anon'a düşer.
 */
async function resolveAccessToken(accessToken) {
  if (typeof accessToken !== 'function') return null;
  try {
    const r = await accessToken();
    return r && r.ok && typeof r.token === 'string' && r.token ? r.token : null;
  } catch {
    return null; // köprü/oturum yok → anon (sessiz çökme yerine bugünkü davranış)
  }
}

/**
 * ADP-334 — /m/office gövdesi (agents + delegations + alerts). Renderer'a SORULMAZ.
 *
 * @param {object} deps
 * @param {{url:string, key:string, schema?:string}} deps.supabase  masaüstüyle AYNI hedef (ADP-773)
 * @param {() => Promise<{ok:boolean, token?:string}>} [deps.accessToken]  ADP-773 — app-DB kimliği
 * @param {() => Array} deps.listPanes                main pty defteri
 * @param {() => Promise<object>|object} deps.delegationState  pencere açıksa renderer, değilse disk
 * @param {typeof fetch} [deps.fetchImpl]             test seam
 */
async function officeSnapshot({ supabase, accessToken, listPanes, delegationState, fetchImpl }) {
  // Jeton BİR kez çözülür ve iki sorguda da kullanılır (iki ayrı IPC turu olmasın).
  const token = await resolveAccessToken(accessToken);
  const [agents, spriteRows, delegation] = await Promise.all([
    selectRows(supabase, 'agents', 'id, display_name, department, role', fetchImpl, token),
    // Sprite ikincildir: okunamazsa mobil baş-harf kutucuğuna düşer, ofis yine çizilir.
    selectRows(supabase, 'employees', 'agent_id, sprite', fetchImpl, token).catch(() => []),
    Promise.resolve(typeof delegationState === 'function' ? delegationState() : delegationState).catch(() => ({})),
  ]);

  const sprites = new Map();
  for (const row of spriteRows) {
    if (row && row.agent_id && row.sprite) sprites.set(row.agent_id, row.sprite);
  }

  return officeFromParts({
    agents,
    sprites,
    panes: (listPanes ? listPanes() : []) || [],
    delegation: delegation || {},
  });
}

/**
 * Pencere kapalıyken delegasyon durumu: DİSKTEKİ kuyruk defteri (delegationQueueStore).
 * Uçuşta delegasyon olamayacağı için active=0; kuyruk ve limitte-duraklamış kayıtlar
 * kalıcıdır (bir sonraki açılışta devam ederler) → telefon bunları GÖRMELİ.
 */
function delegationStateFromQueue(queueState) {
  const s = queueState || {};
  const paused = Array.isArray(s.paused) ? s.paused : [];
  return {
    assignments: paused
      .filter((p) => p && p.agentId)
      .map((p) => ({ agentId: p.agentId, status: 'paused', title: p.title ?? null })),
    active: 0,
    queued: Array.isArray(s.queued) ? s.queued.length : 0,
  };
}

module.exports = {
  WORKING_STATUSES,
  assignmentFor,
  officeFromParts,
  officeSnapshot,
  delegationStateFromQueue,
  describeRestFailure, // ADP-773 — mesaj sözleşmesi testten doğrudan ölçülebilsin
};
