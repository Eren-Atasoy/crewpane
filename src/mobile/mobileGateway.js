// ADP-293 — MOBİL GATEWAY (ADR-020 §5). CrewPane'in telefondan görülen yüzü.
//
// TASARIM SINIRLARI (hepsi yapısal, ayarla delinemez):
//   • MCP bridge'e (delegationBridge.js) DOKUNMAZ: o loopback + efemer port + kendi
//     token'ı ve ASLA tünellenmez. Bu gateway AYRI bir yüzeydir: SABİT port, TAILNET
//     adresi, AYRI cihaz-eşleşmeli token ailesi.
//   • 0.0.0.0'a asla bağlanmaz (mobileDeviceStore.resolveBindHost → env bile delemez).
//   • Cihaz VARSAYILANI read-only: yazma rotaları `command` kapsamı ister (ADP-296).
//   • input-sim (ADP-265 fare/klavye), dosya silme, ayar/deploy → ROTASI YOK. Yetki
//     meselesi değil, YÜZEY meselesi: bu süreçten erişilemez.
//   • Kill-switch: state.enabled=false → sunucu kapanır; pairing dahil her şey durur.
//   • Her istek audit log'a düşer (token asla yazılmaz).
//
// Veri kaynakları DI ile gelir (main.js bağlar) — gateway hiçbir şeyi yeniden uygulamaz:
//   listPanes()        → main'in canlı pty defteri
//   paneTail(id, n)    → main'in rolling buffer'ı (ANSI temizlenir)
//   officeSnapshot()   → ADP-334: OFİS main'de derlenir (Supabase + pty defteri +
//                        delegasyon durumu) → uygulama penceresi KAPALIYKEN de gelir
//   queryRenderer(k)   → 'delegations' | 'tasks' | 'task' | 'agents' (renderer yüzeyleri)
//   subscribe(cb)      → canlı olay akışı (pane satırı, delegasyon, limit, onay)
//   command(kind, p)   → ADP-296 YAZMA: renderer'ın MEVCUT motorları (sendCommandToAgent /
//                        startTeamDelegationEx / executeDecision / executeBoard). Gateway
//                        yalnız taşır + kapsam/kimlik/audit uygular; iş mantığı YOK.
//   transcribe(p)      → ADP-296 SES: Mac'teki Whisper (OpenAI anahtarı Mac'te kalır)
//   killSwitch()       → ADP-296: telefondan acil kapatma (defterde enabled:false)

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const auth = require('./mobileAuth.cjs');
const store = require('./mobileDeviceStore.cjs');
const instancePaths = require('../config/instancePaths.cjs');
// ADP-312: STT hata sözlüğü + ADP-314: Whisper sözlük ipucu (ikisi de tek yerde).
const jarvisVoice = require('../voice/jarvisVoice.js');
const { sttErrorMessage } = jarvisVoice;

const DEFAULT_PORT = 7823;
const MAX_BODY_BYTES = 64 * 1024; // mobil gövdeler minik
const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // ses (yalnız /m/jarvis) — ~2dk konuşma
// ADP-371 — görsel (yalnız /m/uploads): 10MB ham + multipart/base64 kabarması payı.
const MAX_UPLOAD_BODY_BYTES = 14 * 1024 * 1024;
const MAX_ATTACHMENTS = 4; // tek prompt'a iliştirilebilecek görsel sayısı (mobileUploads ile aynı)
const TAIL_DEFAULT = 40;
const TAIL_MAX = 400;
const SSE_PING_MS = 20_000;
const RATE_MAX = 240; // istek / dakika / cihaz (SSE hariç)
const QUERY_TIMEOUT_MS = 8000;
// Yazma komutları renderer'da GERÇEK iş yapar (pane spawn + 9sn engine-ready + ADP-280
// teslim doğrulaması) → okuma zaman aşımından çok daha uzun bir bütçe gerekir.
const COMMAND_TIMEOUT_MS = 45_000;

/** ADP-293/296 — rota → kapsam (mobileApiTypes.MOBILE_ROUTE_SCOPES'un CJS aynası). */
const ROUTE_SCOPES = Object.freeze({
  'POST /m/pair': 'public',
  'GET /m/health': 'public',
  // ADP-313 — ajanların PIXEL-ART sprite'ı (masaüstü ofisiyle aynı PNG'ler). Sır DEĞİL,
  // veri DEĞİL: statik oyun varlığı. Public, çünkü <Image> etiketi (RN/web) Authorization
  // başlığı taşımaz; yine de yalnız sprite dizinindeki bilinen key'ler servis edilir.
  'GET /m/sprite/:key': 'public',
  'GET /m/office': 'read',
  'GET /m/panes': 'read',
  'GET /m/panes/:paneId/tail': 'read',
  // ADP-368 — OKUMA MODU: ham VT yerine claude oturum defterinden (JSONL) yapılandırılmış
  // sohbet akışı. Main'de derlenir (pane→{cwd,sessionId} pty defterinden; renderer'a sorulmaz).
  'GET /m/panes/:paneId/transcript': 'read',
  'GET /m/delegations': 'read',
  // ADP-326 — GÖREV-MERKEZLİ akış (ADR-023 K5/K6): görevleri ARA/SÜZ → birini SEÇ
  // (detay) → BOŞ ajanı SEÇ → o göreve delege et. Serbest metinli `POST /m/delegate`
  // KALDIRILDI (ADR-023 §7 B4): telefondan "şunu yap" demenin yolu Jarvis'tir.
  'GET /m/tasks': 'read',
  'GET /m/tasks/:taskId': 'read',
  'GET /m/agents': 'read',
  // ADP-364 — RAPORLAR: ajan sonuç raporları. INDEX.md main'de parse edilir (ofis gibi:
  // renderer'a sorulmaz, pencere kapalıyken de gelir). Salt-okunur → `read`.
  'GET /m/reports': 'read',
  'GET /m/reports/:reportId': 'read',
  'GET /m/stream': 'read',
  // ADP-317 — Jarvis konuşma geçmişi (TEK defter, main'de). Okuma: telefon açılışta
  // masaüstüyle AYNI konuşmayı görür; sonrası SSE ile canlı akar.
  'GET /m/jarvis/history': 'read',
  // ADP-296 — YAZMA (canlı):
  'POST /m/prompt': 'command',
  'POST /m/panes/:paneId/prompt': 'command',
  'POST /m/tasks': 'command',
  // ADP-326 — TEK delegasyon yolu: BU görevi BU ajana ver (board + gerçek pane).
  'POST /m/tasks/:taskId/delegate': 'command',
  'POST /m/jarvis': 'command',
  // ADP-371 — GÖRSEL YÜKLEME: telefondan foto/ekran görüntüsü → Mac diski (mobile-uploads).
  // Kapsam `command`: yükleme, bir sonraki adımda pane'e yazılacak prompt'un parçasıdır;
  // read cihaz Mac diskine bayt yazamaz. Dönen uploadId, POST /m/prompt `attachments`
  // alanında kullanılır (id sunucu-üretimi; yol telefona ASLA dönmez).
  'POST /m/uploads': 'command',
  // ADP-314 — SES → METİN, teslim YOK (Jarvis yorumu da yok). Kapsam `command`:
  // okuma-yetkili cihaz Mac'in OpenAI anahtarını harcayamaz ve bu metin bir sonraki
  // adımda pane'e yazılacak bir komuttur — read cihazın işi değil.
  'POST /m/transcribe': 'command',
  'POST /m/approve': 'command',
  'POST /m/approvals/:approvalId': 'command',
  'POST /m/stop': 'command',
  'POST /m/killswitch': 'command',
});

/** Rota anahtarı → renderer komut adı (tek yazma yolu: hepsi `command` DI'sinden geçer). */
const COMMAND_KINDS = Object.freeze({
  'POST /m/prompt': 'prompt',
  'POST /m/panes/:paneId/prompt': 'prompt',
  'POST /m/tasks': 'tasks',
  'POST /m/tasks/:taskId/delegate': 'task-delegate', // ADP-326 (serbest metin rotası kalktı)
  'POST /m/jarvis': 'jarvis',
  'POST /m/approve': 'approve',
  'POST /m/approvals/:approvalId': 'approve',
  'POST /m/stop': 'stop',
});

/** ADP-326 — okuma rotası → renderer sorgu adı (parametreler URL'den süzülür).
 *  ADP-334: `office` BURADA YOK — ofis artık main'de üretilir (mobileOffice.cjs),
 *  renderer'a sorulmaz; pencere kapalıyken de cevap verir. */
const QUERY_KINDS = Object.freeze({
  'GET /m/delegations': 'delegations',
  'GET /m/tasks': 'tasks',
  'GET /m/tasks/:taskId': 'task',
  'GET /m/agents': 'agents',
});

const TASK_STATUSES = Object.freeze(['backlog', 'todo', 'in_progress', 'review', 'done']);
const TASKS_LIMIT_DEFAULT = 25;
const TASKS_LIMIT_MAX = 100;

// ADP-556 — mobil web arayüzü (expo export çıktısı) için MIME tablosu. Bilinmeyen
// uzantı octet-stream: tarayıcı çalıştırmaz, indirir (nosniff ile birlikte güvenli taraf).
const WEB_MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  // MOB-UX-M1 (M1-a) — PWA manifest'i. Bu satır OLMADAN manifest
  // `application/octet-stream` ile gider ve aşağıdaki `nosniff` ile birlikte
  // tarayıcı onu REDDEDER: ana ekrana ekleme sessizce yer imine düşer.
  '.webmanifest': 'application/manifest+json',
});

function trimmed(v, max = 120) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * ADP-326 — okuma parametreleri: gateway SÜZER (whitelist), iş mantığı YAPMAZ.
 * Renderer bu nesneyi Supabase sorgusuna çevirir (mobileBridgeClient).
 */
function queryParamsFor(kind, url, taskId) {
  if (kind === 'task') return { taskId };
  if (kind === 'agents') {
    return {
      // ?free=true → BOŞTAKİLER ÖNCE (filtre değil sıralama: meşgul ajan da görünür,
      // ama neden meşgul olduğu yazar → patron bilerek seçer).
      free: url.searchParams.get('free') === 'true',
      taskId: trimmed(url.searchParams.get('taskId'), 64), // departman eşleşmesi → öneri
    };
  }
  if (kind !== 'tasks') return {};
  const status = trimmed(url.searchParams.get('status'), 20);
  // DİKKAT: parametre YOKSA Number(null) = 0'dır (NaN değil) → clamp'e sokulursa limit
  // sessizce 1 olur ve telefon board'un yalnız İLK satırını görür. Yokluk ≠ 0.
  const rawLimit = Number(trimmed(url.searchParams.get('limit'), 10) ?? NaN);
  const rawOffset = Number(trimmed(url.searchParams.get('offset'), 10) ?? NaN);
  return {
    q: trimmed(url.searchParams.get('q'), 80),
    team: trimmed(url.searchParams.get('team'), 40), // departman SLUG'ı (crewpane…)
    sprint: trimmed(url.searchParams.get('sprint'), 60),
    status: status && TASK_STATUSES.includes(status) ? status : null,
    assignee: trimmed(url.searchParams.get('assignee'), 40), // 'none' → atanmamışlar
    limit: Number.isFinite(rawLimit) ? Math.min(TASKS_LIMIT_MAX, Math.max(1, Math.trunc(rawLimit))) : TASKS_LIMIT_DEFAULT,
    offset: Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0,
  };
}

/**
 * ADP-364 — /m/reports süzgeç parametreleri (whitelist). Gateway yalnız SÜZER; liste/facet
 * mantığı mobileReports.cjs'te (main). limit/offset sayı değilse mobileReports varsayılana düşer.
 */
function reportListParams(url) {
  const num = (k) => {
    const v = url.searchParams.get(k);
    return v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined;
  };
  const evidence = trimmed(url.searchParams.get('evidence'), 4);
  return {
    q: trimmed(url.searchParams.get('q'), 80),
    team: trimmed(url.searchParams.get('team'), 40),
    agent: trimmed(url.searchParams.get('agent'), 40),
    sprint: trimmed(url.searchParams.get('sprint'), 40),
    evidence: evidence === 'yes' || evidence === 'no' ? evidence : undefined,
    limit: num('limit'),
    offset: num('offset'),
  };
}

/** ADP-364 — /m/reports/:id sayfalama parametreleri (büyük rapor tek seferde inmez). */
function reportDetailParams(url) {
  const page = Number(url.searchParams.get('page'));
  return { page: Number.isFinite(page) ? page : 0 };
}

function send(res, status, obj) {
  const json = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

function readRaw(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readBody(req, maxBytes) {
  return readRaw(req, maxBytes).then((buf) => buf.toString('utf8'));
}

/**
 * ADP-296 — MİNİMAL multipart/form-data ayrıştırıcı (yalnız mobil ses yolu için).
 * Tek dosya alanı (`audio`) + düz metin alanları yeter; genel bir multipart kütüphanesi
 * getirmeye değmez. Dosya parçası → { audioBase64, mimeType }, metin parçaları → alan.
 * Sınır (boundary) bulunamazsa null → çağıran 400 basar (sessiz yanlış-ayrıştırma YOK).
 */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const boundary = m && (m[1] || m[2] || '').trim();
  if (!boundary) return null;
  const sep = Buffer.from(`--${boundary}`);
  const out = {};
  let pos = buf.indexOf(sep);
  if (pos < 0) return null;
  pos += sep.length;
  while (pos < buf.length) {
    if (buf.slice(pos, pos + 2).toString() === '--') break; // kapanış sınırı
    const headEnd = buf.indexOf('\r\n\r\n', pos);
    if (headEnd < 0) break;
    const head = buf.slice(pos, headEnd).toString('utf8');
    let next = buf.indexOf(sep, headEnd);
    if (next < 0) next = buf.length;
    const body = buf.slice(headEnd + 4, Math.max(headEnd + 4, next - 2)); // sondaki \r\n hariç
    const nameM = /name="([^"]+)"/i.exec(head);
    const name = nameM ? nameM[1] : null;
    const isFile = /filename="/i.test(head);
    if (name) {
      if (isFile) {
        const typeM = /content-type:\s*([^\r\n;]+)/i.exec(head);
        const fileM = /filename="([^"]*)"/i.exec(head);
        out[name] = {
          audioBase64: body.toString('base64'),
          mimeType: typeM ? typeM[1].trim() : 'audio/m4a',
          // ADP-312: uzantı Whisper'ın TEK format sinyali → dosya adını atma.
          fileName: fileM ? fileM[1].trim() : '',
        };
      } else {
        out[name] = body.toString('utf8');
      }
    }
    pos = next + sep.length;
  }
  return out;
}

/** İstek yolunu rota anahtarına çevir (paramlı rotalar: tail · pane-prompt · approvals). */
function routeKeyFor(method, pathname) {
  const tail = /^\/m\/panes\/([^/]+)\/tail$/.exec(pathname);
  if (tail && method === 'GET') return { key: 'GET /m/panes/:paneId/tail', paneId: decodeURIComponent(tail[1]) };
  // ADP-368 — okuma modu sayfası (claude oturum JSONL'inden).
  const transcript = /^\/m\/panes\/([^/]+)\/transcript$/.exec(pathname);
  if (transcript && method === 'GET') {
    return { key: 'GET /m/panes/:paneId/transcript', paneId: decodeURIComponent(transcript[1]) };
  }
  const panePrompt = /^\/m\/panes\/([^/]+)\/prompt$/.exec(pathname);
  if (panePrompt && method === 'POST') {
    return { key: 'POST /m/panes/:paneId/prompt', paneId: decodeURIComponent(panePrompt[1]) };
  }
  const approval = /^\/m\/approvals\/([^/]+)$/.exec(pathname);
  if (approval && method === 'POST') {
    return { key: 'POST /m/approvals/:approvalId', approvalId: decodeURIComponent(approval[1]) };
  }
  // ADP-326 — /delegate ÖNCE eşleşmeli: aksi halde ":taskId" alt-yolu yutardı.
  const taskDelegate = /^\/m\/tasks\/([^/]+)\/delegate$/.exec(pathname);
  if (taskDelegate && method === 'POST') {
    return { key: 'POST /m/tasks/:taskId/delegate', taskId: decodeURIComponent(taskDelegate[1]) };
  }
  const taskDetail = /^\/m\/tasks\/([^/]+)$/.exec(pathname);
  if (taskDetail && method === 'GET') {
    return { key: 'GET /m/tasks/:taskId', taskId: decodeURIComponent(taskDetail[1]) };
  }
  // ADP-364 — /m/reports/<reportId> (görev id'si). reportId INDEX.md'de aranır (uydurma
  // yol yok); segment içinde eğik çizgi olamaz (tek parça) → dizin gezme imkânsız.
  const reportDetail = /^\/m\/reports\/([^/]+)$/.exec(pathname);
  if (reportDetail && method === 'GET') {
    return { key: 'GET /m/reports/:reportId', reportId: decodeURIComponent(reportDetail[1]) };
  }
  // ADP-313 — /m/sprite/<key>.png · key ALLOWLIST'i regex: küçük harf, rakam, _ ve -
  // (nokta/eğik çizgi YOK → dizin gezme imkânsız; dosya varlığı ayrıca kontrol edilir).
  const sprite = /^\/m\/sprite\/([a-z0-9_-]{1,64})\.png$/.exec(pathname);
  if (sprite && method === 'GET') return { key: 'GET /m/sprite/:key', spriteKey: sprite[1] };
  return { key: `${method} ${pathname}`, paneId: null };
}

/**
 * @param {object} opts
 * @param {() => Array} opts.listPanes                 canlı pane listesi (main)
 * ADP-324 — paneTail(paneId, {lines, before, since}) → VT ekranından seq'li satırlar
 * @param {(paneId:string, opts:{lines:number,before:?number,since:?number}) => object|null} opts.paneTail
 * @param {(kind:'delegations'|'tasks'|'task'|'agents', params:object) => Promise<object>} opts.queryRenderer
 * ADP-334 — ofis MAIN'de derlenir (renderer'a sorulmaz): pencere kapalıyken de gelir.
 * @param {() => Promise<{agents:Array, delegations:object, alerts:Array}>} opts.officeSnapshot
 * @param {(cb:(event:object)=>void) => (()=>void)} opts.subscribe   canlı olay akışı
 * @param {(msg:string)=>void} [opts.log]
 * @param {number} [opts.port]
 */
async function startMobileGateway(opts) {
  const log = opts.log || (() => {});
  // ADP-313 — pixel sprite'ların kaynağı (masaüstü ofisiyle AYNI klasör). Verilmezse
  // sprite rotası 404 döner ve mobil baş-harf kutucuğuna düşer (kırılmaz).
  const spriteDir = opts.spriteDir || null;
  // ADP-556 — MOBİL WEB ARAYÜZÜ: expo export çıktısı (index.html + hash'li bundle)
  // gateway'den sunulur → telefon dev server OLMADAN http://<host>:7823/ açar.
  // YÜZEY KURALI DEĞİŞMEZ: /m/* rota tablosu aynen; buraya yalnız /m/* DIŞI GET'ler
  // düşer ve API'ye yeni rota EKLENMEZ (statik dosya = arayüzün kendisi, veri değil).
  // index.html yoksa (bundle üretilmemiş) davranış eskisi gibi: her şey 404.
  const webRoot = (() => {
    try {
      const d = opts.webRoot ? path.resolve(String(opts.webRoot)) : null;
      return d && fs.existsSync(path.join(d, 'index.html')) ? d : null;
    } catch {
      return null;
    }
  })();
  const port = Number(opts.port || process.env.CREWPANE_MOBILE_PORT || DEFAULT_PORT);
  const bind = store.resolveBindHost();
  const instance = instancePaths.instanceId();
  // ADP-372 — masaüstü kimliği /m/health'te: telefon "masaüstü hangi sürümde?" sorusunu
  // buradan cevaplar. String() zorlaması ADP-316 dersi: tamamen-rakam kısa hash Number'a
  // dönüşmüştü ve `!==` karşılaştırması temiz build'de bile MISMATCH veriyordu.
  const appInfo = opts.appInfo || {};
  const appVersion = appInfo.version != null ? String(appInfo.version) : null;
  const appCommit = appInfo.commit != null ? String(appInfo.commit) : null;

  let state = store.loadState();
  if (!state.enabled) {
    log(`mobile gateway: KAPALI (kill-switch) — ~/.crewpane*/mobile-devices.json enabled:false`);
    return null;
  }

  const pending = new Map(); // eşleşme kodu → {expiresAt}
  const allow = auth.makeRateLimiter(RATE_MAX, 60_000);
  const sseClients = new Set();

  function reloadState() {
    state = store.loadState();
    return state;
  }
  function persist() {
    store.saveState(state);
  }
  function audit(fields) {
    store.appendAudit(auth.auditLine(fields));
  }

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress || null;
    let url;
    try {
      url = new URL(req.url, `http://${bind.host}`);
    } catch {
      send(res, 400, { ok: false, reason: 'error', error: 'bad url' });
      return;
    }
    const { key, paneId, approvalId, spriteKey, taskId, reportId } = routeKeyFor(req.method, url.pathname);
    const scope = ROUTE_SCOPES[key];

    if (!scope) {
      // ADP-556 — /m/* DIŞI GET = mobil web arayüzü (bundle varsa). /m/* API yüzeyi
      // AYNEN: scope'lu rotalar yukarıda eşleşti, TANIMSIZ /m/* yolu yine aşağıda 404
      // (input-sim / dosya / ayar / deploy buraya asla düşemez). Statik sunum da aynı
      // kapılardan geçer: kill-switch (authorize public), anonim rate-limit, audit.
      if (webRoot && req.method === 'GET' && !url.pathname.startsWith('/m/')) {
        reloadState(); // kill-switch ANINDA geçerli (API rotalarıyla aynı disiplin)
        const v = auth.authorize({ state, token: null, requiredScope: 'public' });
        if (!v.ok) {
          audit({ ip, method: req.method, path: url.pathname, status: v.status, reason: v.reason });
          send(res, v.status, { ok: false, reason: v.reason, error: v.error });
          return;
        }
        if (!allow(`anon:${ip}`)) {
          audit({ ip, method: req.method, path: url.pathname, status: 429, reason: 'rate-limited' });
          send(res, 429, { ok: false, reason: 'rate-limited', error: 'çok fazla istek' });
          return;
        }
        try {
          const served = serveWeb(url.pathname, res);
          if (served === null) {
            // MOB-UX-M1 — var olmayan VARLIK: SPA'ya düşürmek yerine dürüst 404
            // (yoksa manifest/ikon hatası ekranda hiç görünmez, bkz. serveWeb).
            audit({ ip, method: 'GET', path: url.pathname, status: 404, reason: 'not-found', note: 'web:asset' });
            send(res, 404, { ok: false, reason: 'not-found', error: 'dosya yok' });
            return;
          }
          audit({ ip, method: 'GET', path: url.pathname, status: 200, note: `web:${served}` });
        } catch (err) {
          audit({ ip, method: 'GET', path: url.pathname, status: 500, reason: 'error', note: String(err.message || err) });
          send(res, 500, { ok: false, reason: 'error', error: 'web arayüzü okunamadı' });
        }
        return;
      }
      // TANIMSIZ ROTA = YOK. input-sim / dosya / ayar / deploy buraya asla düşemez.
      audit({ ip, method: req.method, path: url.pathname, status: 404, reason: 'not-found' });
      send(res, 404, { ok: false, reason: 'not-found', error: 'rota yok' });
      return;
    }

    reloadState(); // kill-switch + iptaller ANINDA geçerli (dosya tek-gerçek)
    const token = auth.bearerFrom(req.headers['authorization']);
    const verdict = auth.authorize({ state, token, requiredScope: scope });
    if (!verdict.ok) {
      audit({ ip, method: req.method, path: url.pathname, status: verdict.status, reason: verdict.reason });
      send(res, verdict.status, { ok: false, reason: verdict.reason, error: verdict.error });
      return;
    }
    const device = verdict.device;
    const rlKey = device ? device.id : `anon:${ip}`;
    if (key !== 'GET /m/stream' && !allow(rlKey)) {
      audit({ ip, deviceId: device?.id, deviceName: device?.name, method: req.method, path: url.pathname, status: 429, reason: 'rate-limited' });
      send(res, 429, { ok: false, reason: 'rate-limited', error: 'çok fazla istek' });
      return;
    }
    if (device) {
      device.lastSeenAt = Date.now();
      try {
        persist();
      } catch {
        /* son-görülme yazımı best-effort */
      }
    }
    const ok = (status, body, note) => {
      audit({ ip, deviceId: device?.id, deviceName: device?.name, method: req.method, path: url.pathname, status, note });
      send(res, status, body);
    };

    try {
      // ── public ──────────────────────────────────────────────────────────
      if (key === 'GET /m/health') {
        ok(200, { ok: true, service: 'crewpane-mobile-gateway', instance, apiVersion: 1, version: appVersion, commit: appCommit });
        return;
      }
      // ADP-313 — pixel sprite (48×48 PNG). Statik varlık: cache'lenebilir, veri taşımaz.
      if (key === 'GET /m/sprite/:key') {
        const file = spriteDir ? path.join(spriteDir, spriteKey, '48x48.png') : null;
        if (!file || !fs.existsSync(file)) {
          send(res, 404, { ok: false, reason: 'not-found', error: 'sprite yok' });
          return;
        }
        const png = fs.readFileSync(file);
        res.writeHead(200, {
          'content-type': 'image/png',
          'content-length': png.length,
          'cache-control': 'public, max-age=86400',
          'access-control-allow-origin': '*', // Expo-web kanıt harness'ı (telefon <Image> zaten CORS'suz)
        });
        res.end(png);
        return;
      }
      if (key === 'POST /m/pair') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const r = auth.consumePairing({ pending, code: body.code, deviceName: body.deviceName });
        if (!r.ok) {
          audit({ ip, method: req.method, path: url.pathname, status: r.status, reason: r.reason, note: 'pairing reddedildi' });
          send(res, r.status, { ok: false, reason: r.reason, error: r.error });
          return;
        }
        state.devices.push(r.device);
        persist();
        audit({ ip, deviceId: r.device.id, deviceName: r.device.name, method: req.method, path: url.pathname, status: 200, note: `eşleşti (scope=${r.device.scope})` });
        log(`mobile gateway: cihaz eşleşti ${r.device.name} (${r.device.id}, scope=${r.device.scope})`);
        send(res, 200, { ok: true, deviceId: r.device.id, token: r.token, scope: r.device.scope, instance });
        return;
      }

      // ── READ ────────────────────────────────────────────────────────────
      if (key === 'GET /m/panes') {
        // ADP-335 — TEST-ONLY: bir istek işleyicisinin patlaması SUNUCUYU öldürmemeli.
        // Enjekte edilen hata aşağıdaki global catch'e düşer → 500 + sunucu ayakta.
        if (String(process.env.CREWPANE_FAULT_INJECT || '').split(',').includes('gateway')) {
          throw new TypeError('sentetik gateway handler hatası (fault-inject)');
        }
        const panes = (opts.listPanes ? opts.listPanes() : []) || [];
        ok(200, { ok: true, panes });
        return;
      }
      if (key === 'GET /m/panes/:paneId/tail') {
        const n = Math.min(TAIL_MAX, Math.max(1, Number(url.searchParams.get('lines') || TAIL_DEFAULT)));
        // ADP-324 — seq'li sayfalama: `before` geriye kaydırma, `since` kopan SSE'de boşluk
        // doldurma. Sayı değilse yok sayılır (varsayılan: son N satır + canlı satırlar).
        const num = (k) => {
          const v = Number(url.searchParams.get(k));
          return url.searchParams.has(k) && Number.isFinite(v) ? v : null;
        };
        const t = opts.paneTail ? opts.paneTail(paneId, { lines: n, before: num('before'), since: num('since') }) : null;
        if (!t) {
          ok(404, { ok: false, reason: 'not-found', error: 'pane yok' });
          return;
        }
        // SÖZLEŞME (mobile/src/api/client.ts `getPaneTail` ile birebir): `lines` artık
        // {seq,text} NESNELERİ taşır — istemci `seq` alanının varlığına bakarak yeni/eski
        // gateway'i ayırt eder ve sayfalamayı ona göre açar. Düz string dizisi = ESKİ uç.
        ok(200, {
          ok: true,
          paneId,
          lines: t.entries || [], // [{seq,text}] — kesinleşmiş satırlar
          live: t.live || [], // viewport'ta duran, HENÜZ kesinleşmemiş satırlar (seq YOK)
          firstSeq: t.firstSeq || 0,
          lastSeq: t.lastSeq || 0,
          hasMore: !!t.hasMore, // daha eskisi var → ?before=firstSeq
          gapped: !!t.gapped, // `since` defterden düşmüş → istemci tam tail çekmeli
          bytesCapped: !!t.bytesCapped,
          truncated: !!t.truncated,
        });
        return;
      }
      // ADP-368 — OKUMA MODU: pane'in claude oturum defterinden yapılandırılmış sayfa.
      // paneTranscript DI'sı main'de koşar (fs oradadır); pane yoksa null → 404.
      if (key === 'GET /m/panes/:paneId/transcript') {
        if (!opts.paneTranscript) {
          ok(503, { ok: false, reason: 'error', error: 'okuma modu kaynağı bağlı değil' }, 'transcript unavailable');
          return;
        }
        // DİKKAT: yokluk ≠ 0 (ADP-326 tuzağı) — parametre yoksa varsayılan, sıfır değil.
        const num = (k) => {
          const v = Number(url.searchParams.get(k));
          return url.searchParams.has(k) && Number.isFinite(v) ? v : null;
        };
        const rawLimit = num('limit');
        const t = opts.paneTranscript(paneId, {
          limit: rawLimit == null ? undefined : rawLimit,
          before: num('before') ?? undefined,
        });
        if (!t) {
          ok(404, { ok: false, reason: 'not-found', error: 'pane yok' });
          return;
        }
        ok(200, {
          ok: true,
          paneId,
          supported: t.supported === true,
          items: t.items || [],
          firstOff: t.firstOff || 0,
          hasMore: !!t.hasMore,
        });
        return;
      }
      // ADP-334 — OFİS: main'de derlenir (Supabase + pty defteri + delegasyon durumu).
      // Uygulama penceresi kapalı olsa bile telefon ofisi görür (renderer'a sorulmaz).
      if (key === 'GET /m/office') {
        if (!opts.officeSnapshot) {
          ok(503, { ok: false, reason: 'error', error: 'ofis kaynağı bağlı değil' }, 'office unavailable');
          return;
        }
        let office = null;
        try {
          office = await withTimeout(Promise.resolve(opts.officeSnapshot()), QUERY_TIMEOUT_MS);
        } catch (err) {
          ok(502, { ok: false, reason: 'error', error: `ofis okunamadı: ${err.message}` }, 'office error');
          return;
        }
        ok(200, { ok: true, instance, scope: device.scope, serverTime: Date.now(), ...office });
        return;
      }
      // ADP-364 — RAPORLAR: main'de INDEX.md'den derlenir (ofis gibi; renderer'a sorulmaz).
      if (key === 'GET /m/reports') {
        if (!opts.reportsList) {
          ok(503, { ok: false, reason: 'error', error: 'rapor kaynağı bağlı değil' }, 'reports unavailable');
          return;
        }
        let data = null;
        try {
          data = await withTimeout(Promise.resolve(opts.reportsList(reportListParams(url))), QUERY_TIMEOUT_MS);
        } catch (err) {
          ok(502, { ok: false, reason: 'error', error: `raporlar okunamadı: ${err.message}` }, 'reports error');
          return;
        }
        ok(200, { ok: true, ...data });
        return;
      }
      if (key === 'GET /m/reports/:reportId') {
        if (!opts.reportRead) {
          ok(503, { ok: false, reason: 'error', error: 'rapor kaynağı bağlı değil' }, 'reports unavailable');
          return;
        }
        let report = null;
        try {
          report = await withTimeout(Promise.resolve(opts.reportRead(reportId, reportDetailParams(url))), QUERY_TIMEOUT_MS);
        } catch (err) {
          ok(502, { ok: false, reason: 'error', error: `rapor okunamadı: ${err.message}` }, 'report error');
          return;
        }
        if (!report) {
          ok(404, { ok: false, reason: 'not-found', error: `rapor yok: ${reportId}` });
          return;
        }
        ok(200, { ok: true, report });
        return;
      }
      const queryKind = QUERY_KINDS[key];
      if (queryKind) {
        let data = null;
        try {
          // ADP-326 — parametreler (arama/filtre/sayfalama/taskId) renderer'a TAŞINIR;
          // sorguyu MEVCUT Supabase yüzeyi kurar (gateway'de ikinci bir board mantığı YOK).
          data = await withTimeout(opts.queryRenderer(queryKind, queryParamsFor(queryKind, url, taskId)), QUERY_TIMEOUT_MS);
        } catch (err) {
          ok(503, { ok: false, reason: 'error', error: `uygulama penceresi cevap vermedi: ${err.message}` }, 'renderer timeout');
          return;
        }
        // Renderer hatası SESSİZCE ok:true'ya karışmasın (eskiden `{error}` gövdeye
        // sızıyor ama 200 dönüyordu → telefon "boş liste" sanıyordu).
        if (data && data.error) {
          const notFound = data.reason === 'not-found';
          ok(notFound ? 404 : 502, { ok: false, reason: notFound ? 'not-found' : 'error', error: String(data.error) });
          return;
        }
        ok(200, { ok: true, ...data });
        return;
      }
      // ADP-317 — konuşma geçmişi: renderer'a SORULMAZ (defter main'de). Uygulama
      // penceresi cevap vermese bile telefon geçmişi görür.
      if (key === 'GET /m/jarvis/history') {
        // ADP-329 — SAYFALAMA: açılışta son `limit` satır; yukarı kaydırınca
        // `before=<turnId>` ile bir önceki sayfa. Defterin TAMAMI artık gitmiyor
        // (ADR-023 K3 ile aynı gerekçe: hücresel veride tam defter kabul edilemez).
        const rawLimit = Number(trimmed(url.searchParams.get('limit'), 10) ?? NaN);
        const q = {
          // DİKKAT: parametre yoksa Number(null)=0'dır (NaN değil) → clamp limit'i 1'e
          // düşürürdü. Yokluk ≠ 0 (ADP-326'da aynı tuzağa düşülmüştü).
          limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
          before: trimmed(url.searchParams.get('before'), 64),
        };
        const snap = opts.jarvisHistory ? opts.jarvisHistory(q) : { turns: [], approvals: [] };
        ok(200, {
          ok: true,
          turns: snap.turns || [],
          approvals: (snap.approvals || []).filter((a) => a.status === 'open'),
          // Eski uç (sayfalamayı bilmeyen jarvisHistory) `hasMore` döndürmez → false.
          // Telefon bunu "daha eski yok" diye okur: yanlış SAYFA çekmez, sadece
          // eski davranışı (tek sayfa) görür. Sessiz bozulma yok.
          hasMore: snap.hasMore === true,
          firstId: snap.firstId ?? null,
        });
        return;
      }
      if (key === 'GET /m/stream') {
        openStream(req, res, device);
        return;
      }

      // ── YAZMA — ADP-296 (canlı) ─────────────────────────────────────────
      // KILL-SWITCH önce: renderer'a hiç bağlı değil (telefon kaybolduysa uygulama
      // penceresi cevap vermese bile erişim kesilebilmeli).
      if (key === 'POST /m/killswitch') {
        ok(200, { ok: true, stopped: true }, 'kill-switch (mobil)');
        log('mobile gateway: KILL-SWITCH — telefondan kapatıldı');
        setTimeout(() => {
          try {
            opts.killSwitch ? opts.killSwitch() : null;
          } catch (err) {
            log(`mobile gateway: kill-switch hatası: ${err.message}`);
          }
        }, 50); // cevap gitsin, sonra sunucu kapansın
        return;
      }

      // ── ADP-371 — GÖRSEL YÜKLEME (telefon → Mac diski) ──────────────────
      // Renderer'a UĞRAMAZ: baytlar main'de diske düşer (mobileUploads DI'sı),
      // telefona yalnız uploadId döner. Prompt'a iliştirme AYRI adımdır
      // (POST /m/prompt `attachments`) → yükleme başarısız olsa prompt hattı sağlam.
      if (key === 'POST /m/uploads') {
        if (!opts.saveUpload) {
          ok(503, { ok: false, reason: 'error', error: 'yükleme kaynağı bağlı değil' }, 'uploads unavailable');
          return;
        }
        let raw;
        try {
          raw = await readRaw(req, MAX_UPLOAD_BODY_BYTES);
        } catch (err) {
          ok(400, { ok: false, reason: 'error', error: err.message === 'payload too large' ? 'görsel çok büyük (tavan 10MB)' : String(err.message || err) });
          return;
        }
        let buffer = null;
        if (/multipart\/form-data/i.test(String(req.headers['content-type'] || ''))) {
          const parts = parseMultipart(raw, req.headers['content-type']);
          const img = parts && parts.image;
          if (!img || !img.audioBase64) {
            ok(400, { ok: false, reason: 'error', error: 'görsel (image) alanı gerekli (multipart/form-data)' });
            return;
          }
          buffer = Buffer.from(img.audioBase64, 'base64');
        } else {
          // JSON yolu (web kanıt harness'ı): { imageBase64 }
          try {
            const parsed = JSON.parse(raw.toString('utf8') || '{}');
            if (parsed && typeof parsed.imageBase64 === 'string') buffer = Buffer.from(parsed.imageBase64, 'base64');
          } catch {
            /* aşağıda 400 */
          }
          if (!buffer) {
            ok(400, { ok: false, reason: 'error', error: 'görsel gerekli: multipart `image` alanı ya da JSON `imageBase64`' });
            return;
          }
        }
        const r = opts.saveUpload({ buffer });
        if (!r || !r.ok) {
          ok(400, { ok: false, reason: 'error', error: (r && r.error) || 'görsel kaydedilemedi' }, 'upload reddedildi');
          return;
        }
        ok(200, { ok: true, uploadId: r.uploadId, bytes: r.bytes, kind: r.kind }, `görsel yüklendi (${r.bytes}B ${r.kind})`);
        return;
      }

      // ── ADP-314 — SES → METİN (yorum yok, teslim yok) ───────────────────
      // Ajana SESLİ prompt'un birinci yarısı. İkinci yarısı MEVCUT yoldur:
      // istemci metni görür/düzeltir, sonra POST /m/prompt (sendCommandToAgent +
      // ADP-280 teslim doğrulaması). Ses hattı teslim hattını KOPYALAMAZ.
      if (key === 'POST /m/transcribe') {
        const payload = await readCommandPayload(req, 'transcribe');
        if (!payload.ok) {
          ok(400, { ok: false, reason: 'error', error: payload.error });
          return;
        }
        const value = payload.value;
        if (!value.audioBase64) {
          ok(400, { ok: false, reason: 'error', error: 'ses (audio) alanı gerekli' });
          return;
        }
        const t = await runStt(value);
        if (!t.ok) {
          ok(400, { ok: false, reason: 'stt-failed', error: t.error }, `stt fail (${t.reason})`);
          return;
        }
        ok(200, { ok: true, text: t.text }, 'transkript (teslim YOK)');
        return;
      }

      const kind = COMMAND_KINDS[key];
      if (kind) {
        if (!opts.command) {
          ok(503, { ok: false, reason: 'error', error: 'komut yüzeyi bağlı değil (uygulama penceresi yok)' });
          return;
        }
        const payload = await readCommandPayload(req, kind);
        if (!payload.ok) {
          ok(400, { ok: false, reason: 'error', error: payload.error });
          return;
        }
        const value = payload.value;
        if (paneId) value.paneId = paneId;
        if (approvalId) value.approvalId = approvalId;
        if (taskId) value.taskId = taskId; // ADP-326 — görev kimliği YOLDAN gelir (gövde ezemez)

        // ADP-371 — prompt'a görsel iliştirme: telefon uploadId listesi yollar, MUTLAK
        // YOLA çözme BURADA (main) yapılır — resolveUpload regex + kök-kontrolüyle
        // traversal'ı yapısal olarak keser; bilinmeyen/çürük id = 400 (sessiz düşme yok).
        // Renderer'a `attachmentPaths` gider; telefondan gelen `attachments` renderer'a taşınmaz.
        if (kind === 'prompt' && value.attachments != null) {
          const list = Array.isArray(value.attachments) ? value.attachments : null;
          if (!list || list.length > MAX_ATTACHMENTS) {
            ok(400, { ok: false, reason: 'error', error: `attachments en çok ${MAX_ATTACHMENTS} uploadId listesi olmalı` });
            return;
          }
          const paths = [];
          for (const id of list) {
            const file = opts.resolveUpload ? opts.resolveUpload(id) : null;
            if (!file) {
              ok(400, { ok: false, reason: 'error', error: `görsel bulunamadı: ${trimmed(id, 80) || '(boş)'}` }, 'attachment reddedildi');
              return;
            }
            paths.push(file);
          }
          delete value.attachments;
          if (paths.length) value.attachmentPaths = paths;
        }

        // SES → METİN: transkript MAC'te (OpenAI anahtarı telefona kopyalanmaz).
        let transcript = null;
        if (kind === 'jarvis' && value.audioBase64) {
          const t = await runStt(value);
          if (!t.ok) {
            const status = t.reason === 'no-transcriber' ? 503 : 400;
            ok(status, { ok: false, reason: status === 503 ? 'error' : 'stt-failed', error: t.error }, `stt fail (${t.reason})`);
            return;
          }
          transcript = t.text;
          value.text = transcript;
          delete value.audioBase64; // ham ses renderer'a/log'a taşınmaz
        }

        let result;
        try {
          result = await withTimeout(opts.command(kind, value), COMMAND_TIMEOUT_MS);
        } catch (err) {
          ok(504, { ok: false, reason: 'error', error: `komut tamamlanmadı: ${err.message}` }, 'command timeout');
          return;
        }
        if (!result || !result.ok) {
          const error = (result && result.error) || 'komut başarısız';
          ok(result && result.reason === 'not-found' ? 404 : 400, {
            ok: false,
            reason: (result && result.reason) || 'error',
            error,
          });
          return;
        }
        ok(200, { ...result, ...(transcript ? { transcript } : {}) }, `komut: ${kind}`);
        return;
      }

      send(res, 404, { ok: false, reason: 'not-found', error: 'rota yok' });
    } catch (err) {
      audit({ ip, deviceId: device?.id, method: req.method, path: url.pathname, status: 500, reason: 'error', note: String(err.message || err) });
      send(res, 500, { ok: false, reason: 'error', error: String(err.message || err) });
    }
  });

  /**
   * ADP-556 — statik web dosyası sun. Yol webRoot İÇİNDE kalmak zorunda (normalize +
   * prefix kontrolü traversal'ı yapısal keser); dosya yoksa SPA fallback → index.html
   * (tarayıcıda uygulama-içi rotayı yenilemek de açılır). Hash'li expo çıktıları
   * (_expo/, assets/) içerik-adresli → 1 yıl immutable cache; index.html no-store
   * (yeni build'de taze bundle'a işaret eden tek dosya odur).
   * Dönüş: audit notu için webRoot'a göre servis edilen dosya yolu — ya da
   * `null`: istenen VARLIK (uzantılı yol) yok, çağıran 404 döndürmeli.
   */
  function serveWeb(pathname, res) {
    let rel = '/';
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      /* bozuk kaçış → SPA fallback */
    }
    const resolved = path.normalize(path.join(webRoot, rel.replace(/\\/g, '/')));
    let file = null;
    if (resolved === webRoot || resolved.startsWith(webRoot + path.sep)) {
      try {
        if (fs.statSync(resolved).isFile()) file = resolved;
      } catch {
        /* yok → SPA fallback */
      }
    }
    const isSpaFallback = !file;
    // MOB-UX-M1 (M1-a) — VARLIK YOLU SPA'ya DÜŞMEZ. Eskiden bulunamayan HER yol
    // 200 + index.html dönüyordu: yanlış yazılmış bir `manifest.webmanifest` /
    // `icon-192.png` hata vermeden HTML alıyordu ve PWA kabuğu SESSİZCE bozuluyordu
    // (ölçüldü — MOB-UX-R1 §7.1: `/sw.js` → "unsupported MIME type ('text/html')").
    // Kural yola bakar, ada değil: uzantısı olan ve `.html` OLMAYAN yol bir dosya
    // talebidir → yoksa 404. Uzantısız yollar (SPA rotaları) eskisi gibi index.html.
    const ext = path.extname(rel).toLowerCase();
    if (isSpaFallback && ext && ext !== '.html' && ext !== '.htm') return null;
    if (!file) file = path.join(webRoot, 'index.html');
    const body = fs.readFileSync(file);
    const hashed = !isSpaFallback && (rel.startsWith('/_expo/') || rel.startsWith('/assets/'));
    res.writeHead(200, {
      'content-type': WEB_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
    return path.relative(webRoot, file);
  }

  /**
   * ADP-312/314 — TEK STT YÜZEYİ (jarvis + transcribe ikisi de buradan geçer).
   * Ses Mac'te çözülür; hata YUTULMAZ (OpenAI'ın gövdesi Mac log'una düşer, telefona
   * dürüst Türkçe sebep gider). Ham ses ne renderer'a ne log'a taşınır.
   *
   * Sözlük ipucu (`prompt`): istemcinin verdiği isimler + CANLI pane etiketleri.
   * Yalnız yazım kalitesi içindir — Whisper'a komut değildir, transkriptin kendisi
   * her zaman kullanıcının söylediği metindir.
   */
  async function runStt(value) {
    if (!opts.transcribe) {
      return { ok: false, reason: 'no-transcriber', error: 'ses transkripti bu sürümde bağlı değil' };
    }
    const names = [];
    for (const p of (opts.listPanes ? opts.listPanes() : []) || []) {
      if (p && p.label) names.push(p.label);
      if (p && p.agentId) names.push(p.agentId);
    }
    const hint = jarvisVoice.buildVocabPrompt([
      ...String(value.hint || '')
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      ...names,
    ]);
    const t = await opts.transcribe({
      audioBase64: value.audioBase64,
      mimeType: value.mimeType,
      fileName: value.fileName, // ADP-312: uzantı = Whisper'ın format sinyali
      prompt: hint || undefined,
    });
    const text = t && t.ok ? String(t.text || '').trim() : '';
    if (!t || !t.ok || !text) {
      const reason = t && t.ok ? 'empty-transcript' : (t && t.reason) || 'bilinmiyor';
      const detail = (t && t.detail) || '';
      const bytes = Math.floor((String(value.audioBase64 || '').length * 3) / 4);
      log(
        `mobile stt: STT başarısız — reason=${reason} bytes=${bytes} mime=${value.mimeType || '?'} ` +
          `file=${value.fileName || '-'}${detail ? ` detail=${String(detail).slice(0, 300)}` : ''}`,
      );
      return { ok: false, reason, error: `ses çözümlenemedi: ${sttErrorMessage(reason, detail)}` };
    }
    return { ok: true, text };
  }

  function openStream(req, res, device) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    const write = (event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* kapanmış istemci */
      }
    };
    write({ type: 'hello', instance, scope: device.scope, at: Date.now() });
    const ping = setInterval(() => write({ type: 'ping', at: Date.now() }), SSE_PING_MS);
    const client = { write, device };
    sseClients.add(client);
    store.appendAudit(auth.auditLine({ deviceId: device.id, deviceName: device.name, method: 'GET', path: '/m/stream', status: 200, note: 'SSE açıldı' }));
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(client);
    });
  }

  /** DI'dan gelen canlı olayları tüm SSE istemcilerine yay (READ kapsamı yeter). */
  const unsubscribe = opts.subscribe
    ? opts.subscribe((event) => {
        for (const c of sseClients) c.write(event);
      })
    : () => {};

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const actual = server.address();
  log(
    `mobile gateway: ${bind.host}:${actual.port} (${bind.kind}${bind.reason ? ` — ${bind.reason}` : ''}) ` +
      `instance=${instance} cihaz=${state.devices.filter((d) => !d.revokedAt).length} ` +
      `web=${webRoot ? webRoot : 'YOK (yalnız API — mobile/dist üretilmemiş)'}`,
  );

  return {
    info: () => ({
      host: bind.host,
      port: actual.port,
      bindKind: bind.kind,
      bindReason: bind.reason || null,
      instance,
      baseUrl: `http://${bind.host}:${actual.port}`,
      // ADP-556 — masaüstü paneli kopyayı buna göre seçer: web arayüzü sunuluyorsa
      // "telefondan şu adresi aç", değilse eski (yalnız API) durumu söyler.
      webUi: !!webRoot,
      devices: store.loadState().devices.map((d) => ({ id: d.id, name: d.name, scope: d.scope, revokedAt: d.revokedAt, lastSeenAt: d.lastSeenAt })),
    }),
    /** Masaüstü "Mobil erişim" paneli: QR içeriği üretir (tek kullanımlık kod). */
    createPairing: () => {
      const { code, expiresAt } = auth.mintPairingCode();
      pending.set(code, { expiresAt });
      const payload = { v: 1, baseUrl: `http://${bind.host}:${actual.port}`, code, instance };
      store.appendAudit(auth.auditLine({ method: 'LOCAL', path: '/pair/create', status: 200, note: 'eşleşme kodu üretildi' }));
      return { ...payload, expiresAt, qr: JSON.stringify(payload) };
    },
    /**
     * ADP-308 — cihaz YETKİSİ (read ⇄ command) masaüstünden değişir. ADP-293'ün
     * kuralı korunuyor: eşleşen cihaz her zaman `read` doğar; 'command' yükseltmesi
     * YALNIZ burada, Mac başındaki bilinçli bir eylemle olur (telefonun kendini
     * yükseltebileceği bir rota YOK). Anında geçerli: bir sonraki istek yeni kapsamla
     * yetkilenir; düşürme (command→read) de aynı anda etkilidir.
     */
    setDeviceScope: (deviceId, scope) => {
      const next = scope === 'command' ? 'command' : 'read';
      const s = store.loadState();
      const d = s.devices.find((x) => x.id === deviceId);
      if (!d || d.revokedAt) return false; // iptal edilmiş cihaz yükseltilemez
      d.scope = next;
      store.saveState(s);
      state = s;
      store.appendAudit(
        auth.auditLine({ deviceId, deviceName: d.name, method: 'LOCAL', path: '/device/scope', status: 200, note: `yetki → ${next}` }),
      );
      log(`mobile gateway: cihaz yetkisi ${deviceId} → ${next}`);
      return true;
    },
    /** Cihaz iptali — ANINDA geçerli (bir sonraki istek 401 'revoked'). */
    revokeDevice: (deviceId) => {
      const s = store.loadState();
      const d = s.devices.find((x) => x.id === deviceId);
      if (!d) return false;
      d.revokedAt = Date.now();
      store.saveState(s);
      state = s;
      store.appendAudit(auth.auditLine({ deviceId, method: 'LOCAL', path: '/device/revoke', status: 200, note: 'cihaz iptal edildi' }));
      log(`mobile gateway: cihaz iptal edildi ${deviceId}`);
      return true;
    },
    stop: () => {
      try {
        unsubscribe();
      } catch {
        /* ignore */
      }
      for (const c of sseClients) {
        try {
          c.write({ type: 'alert', severity: 'warning', title: 'Mobil erişim kapatıldı', detail: 'kill-switch', at: Date.now() });
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      server.close();
      // ADP-296 — server.close() YALNIZ yeni bağlantıyı reddeder: açık keep-alive soketleri
      // ve CANLI SSE akışları yaşamaya devam eder → kill-switch'ten sonra telefon hâlâ
      // cevap alır (e2e'de yakalandı: port "kapalı" sanılıyordu, /m/health 200 dönüyordu).
      // Kill-switch bir GÜVENLİK anahtarıdır: tüm soketler ANINDA koparılır.
      try {
        server.closeAllConnections?.();
      } catch {
        /* eski Node: en azından yeni bağlantı kabul edilmiyor */
      }
      store.appendAudit(auth.auditLine({ method: 'LOCAL', path: '/gateway/stop', status: 200, note: 'gateway durduruldu' }));
      log('mobile gateway: durduruldu (kill-switch)');
    },
  };
}

/** Ses taşıyabilen rotalar (ayrı gövde tavanı + multipart hakkı). */
const AUDIO_KINDS = new Set(['jarvis', 'transcribe']);

/**
 * ADP-296/314 — yazma gövdesini oku: JSON (varsayılan) veya ses rotalarında multipart.
 * Ses tavanı ayrı (MAX_AUDIO_BYTES); diğer gövdeler minik kalır (MAX_BODY_BYTES).
 */
async function readCommandPayload(req, kind) {
  const ctype = String(req.headers['content-type'] || '');
  const audioKind = AUDIO_KINDS.has(kind);
  const limit = audioKind ? MAX_AUDIO_BYTES : MAX_BODY_BYTES;
  let raw;
  try {
    raw = await readRaw(req, limit);
  } catch (err) {
    return { ok: false, error: err.message === 'payload too large' ? 'gövde çok büyük' : String(err.message || err) };
  }
  if (/multipart\/form-data/i.test(ctype)) {
    if (!audioKind) return { ok: false, error: 'bu rota multipart kabul etmez (JSON gönder)' };
    const parts = parseMultipart(raw, ctype);
    if (!parts) return { ok: false, error: 'multipart sınırı (boundary) okunamadı' };
    const audio = parts.audio;
    const value = {};
    if (audio && audio.audioBase64) {
      value.audioBase64 = audio.audioBase64;
      value.mimeType = audio.mimeType;
      if (audio.fileName) value.fileName = audio.fileName;
    }
    if (typeof parts.text === 'string' && parts.text.trim()) value.text = parts.text.trim();
    // ADP-314 — sözlük ipucu (ajan isimleri) multipart yolunda da geçebilsin.
    if (typeof parts.hint === 'string' && parts.hint.trim()) value.hint = parts.hint.trim();
    if (kind === 'transcribe') {
      if (!value.audioBase64) return { ok: false, error: 'ses (audio) alanı gerekli' };
      return { ok: true, value };
    }
    if (!value.audioBase64 && !value.text) return { ok: false, error: 'ses (audio) veya metin (text) alanı gerekli' };
    return { ok: true, value };
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'gövde bir JSON nesnesi olmalı' };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: 'geçersiz JSON' };
  }
}

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

module.exports = {
  DEFAULT_PORT,
  ROUTE_SCOPES,
  COMMAND_KINDS,
  QUERY_KINDS,
  MAX_AUDIO_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  MAX_ATTACHMENTS,
  TASK_STATUSES,
  routeKeyFor,
  queryParamsFor,
  parseMultipart,
  startMobileGateway,
};
