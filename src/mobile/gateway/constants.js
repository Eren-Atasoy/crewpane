// CrewPane — Mobile Gateway Constants, Route Maps & URL Parsers (Phase 4.12)
'use strict';

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

/** Ses taşıyabilen rotalar (ayrı gövde tavanı + multipart hakkı). */
const AUDIO_KINDS = new Set(['jarvis', 'transcribe']);

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

module.exports = {
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  MAX_AUDIO_BYTES,
  MAX_UPLOAD_BODY_BYTES,
  MAX_ATTACHMENTS,
  TAIL_DEFAULT,
  TAIL_MAX,
  SSE_PING_MS,
  RATE_MAX,
  QUERY_TIMEOUT_MS,
  COMMAND_TIMEOUT_MS,
  ROUTE_SCOPES,
  COMMAND_KINDS,
  QUERY_KINDS,
  TASK_STATUSES,
  TASKS_LIMIT_DEFAULT,
  TASKS_LIMIT_MAX,
  WEB_MIME,
  AUDIO_KINDS,
  trimmed,
  queryParamsFor,
  reportListParams,
  reportDetailParams,
  routeKeyFor,
};
