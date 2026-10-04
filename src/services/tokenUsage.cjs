// ADP-887 — JETON ÖLÇÜMÜ: motorların KENDİ defterlerinden gerçek kullanım (main-side).
//
// ÖNCE ÖLÇTÜK, sonra yazdık (görevin 1. maddesi). Bulgular:
//
//   claude  → ~/.claude/projects/<munged-cwd>/<sessionId>.jsonl
//             `{type:'assistant', requestId, message:{model, usage:{input_tokens,
//             output_tokens, cache_read_input_tokens, cache_creation:{ephemeral_5m…,
//             ephemeral_1h…}, speed}}}`. Pane'in sessionId'si BİZİM verdiğimiz uuid
//             (agentRunner.withSessionId) → oturum dosyası KESİN bilinir.
//             🪤 Aynı istek deftere BİRDEN FAZLA satırla düşebilir → requestId/uuid
//             ile tekilleştirilmezse maliyet KATLANARAK yanlış çıkar.
//
//   codex   → ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//             `session_meta.payload.cwd` + `turn_context.payload.model` +
//             `event_msg.payload{type:'token_count', info.total_token_usage}`.
//             🪤 total_token_usage KÜMÜLATİFTİR (oturum başından beri) → satırlar
//             TOPLANMAZ, SONUNCUSU alınır. Codex'in pane-başına oturum kimliği yok:
//             eşleme cwd + pane açılış zamanı ile yapılır (best-effort, öyle raporlanır).
//
// ENG-09 (SPRINT-ENGINE-03) — bu iki dal artık `if engine==='claude'` diye
// YAZILI DEĞİL: motorun kullanım kaynağı descriptor'dan okunur
// (engineRegistry `usage.kind`: session-ledger | time-window | cli-report |
// run-envelope | none)
// ve bir ADAPTÖRE çözülür. Ölçüm SEVİYESİ (`usageLevel`) karta kadar taşınır;
// ölçemediğimiz motor "bilinmiyor" der — TAHMİN YOK (aşağıdaki sözleşme bloğu).
//
// ⚡ Toplam ("tüm oturumlar") her açılışta yüzlerce MB okuyabilirdi. Defterler
// EKLEMELİ olduğu için dosya-başına {offset, kısmi-toplam} önbelleği tutulur:
// ikinci okuma yalnız YENİ baytları görür. Dosya küçülürse (yeniden yazılmış)
// önbellek atılır ve baştan okunur.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const transcriptProbe = require('./transcriptProbe.cjs');
const ledgerPath = require('../config/ledgerPath.cjs');
const tokenCost = require('./tokenCost.cjs');
// ENG-09 — motorun kullanım/fatura kaynağı artık BURADA `if engine==='claude'`
// diye yazılı değil: descriptor'dan (engineRegistry.usage) okunur. Kayıtsız motor
// ya da `usage` beyanı olmayan motor → `none` adaptörü → kart "bilinmiyor" der.
const engineRegistry = require('../agents/engineRegistry.cjs');
const engineBilling = require('../agents/engineBilling.cjs'); // ENG-16 — 4. fatura kipi ('vendor-hosted') TEK kaynağı

/** Tek okumada işlenecek en büyük yeni-bayt (kaçak büyümüş deftere karşı fren). */
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/** Toplam taramasında bakılacak en çok dosya (en yeniden eskiye). */
const MAX_FILES = 300;
/** Codex oturum ağacında geriye bakılacak gün (dizin YYYY/MM/DD). */
const CODEX_LOOKBACK_DAYS = 120;

// ---------------------------------------------------------------------------
// Artımlı dosya okuyucu
// ---------------------------------------------------------------------------

/** file → { mtimeMs, size, offset, carry, state } */
const fileCache = new Map();

/**
 * `file`'ı satır satır işle; ikinci çağrıda YALNIZ yeni baytları oku.
 * @param {string} file
 * @param {() => any} initState kısmi-toplam nesnesini üret
 * @param {(state:any, row:any) => void} onRow her JSON satırı için
 * @returns {any|null} biriken state (dosya yoksa null)
 */
function scanJsonlIncremental(file, initState, onRow) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return null;
  }
  let cached = fileCache.get(file);
  // Boyut küçüldüyse defter yeniden yazılmış → artımlı okuma GEÇERSİZ, baştan al.
  if (cached && st.size < cached.offset) cached = undefined;
  if (!cached) cached = { mtimeMs: 0, size: 0, offset: 0, carry: '', state: initState() };
  // Hiç değişmediyse iş yok.
  if (cached.offset === st.size && cached.mtimeMs === st.mtimeMs) return cached.state;

  const start = cached.offset;
  const want = Math.min(st.size - start, MAX_CHUNK_BYTES);
  let text = '';
  if (want > 0) {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const buf = Buffer.alloc(want);
      const n = fs.readSync(fd, buf, 0, want, start);
      text = buf.subarray(0, n).toString('utf8');
    } catch {
      return cached.state;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* kapatma hatası ölçümü bozmaz */
        }
      }
    }
  }

  const lines = (cached.carry + text).split('\n');
  // Son parça YARIM olabilir (dosya hâlâ yazılıyor) → bir sonraki tura devret.
  const carry = lines.pop() ?? '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // bozuk satır ölçümü durdurmaz
    }
    try {
      onRow(cached.state, row);
    } catch {
      /* tek satırın hatası tüm defteri düşürmesin */
    }
  }
  cached.carry = carry;
  cached.offset = start + want;
  cached.size = st.size;
  cached.mtimeMs = st.mtimeMs;
  fileCache.set(file, cached);
  return cached.state;
}

/** Test/uzun oturum hijyeni: önbelleği boşalt (ölçüm sonucunu değiştirmez). */
function resetCache() {
  fileCache.clear();
}

// ---------------------------------------------------------------------------
// claude defteri
// ---------------------------------------------------------------------------

function claudeHome(override) {
  return override || process.env.CREWPANE_CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function newClaudeState() {
  // TOK-A — `lastRequest`: SON isteğin bağlamı + zamanı. Toplamlar bu soruyu
  // cevaplayamıyor: "tazelemek ne kazandırır" ve "önbellek söndü mü" yalnız EN SON
  // isteğin bağlam BOYUTUYLA (kümülatif toplamla DEĞİL) ve saatiyle ölçülür.
  // TOK-B — `requests`: bu oturumdaki TEKİLLEŞTİRİLMİŞ istek sayısı. Mega-oturum
  // freni (≥300 istek) jetonla değil İSTEK SAYISIYLA tanımlıdır (TOK-OPT-01: 13
  // mega-oturum harcamanın %37'si) → sayacı ölçümün kendi yerinde tutuyoruz.
  return { byModel: new Map(), seen: new Set(), lastRequest: null, requests: 0 };
}

/** Bir `assistant` satırındaki usage'ı modeline ekle (tekilleştirerek). */
function claudeRow(state, row) {
  if (!row || row.type !== 'assistant') return;
  const msg = row.message;
  if (!msg || typeof msg !== 'object') return;
  const u = msg.usage;
  if (!u || typeof u !== 'object') return;
  // 🪤 TEKİLLEŞTİRME — aynı istek deftere birden fazla düşebilir; requestId yoksa uuid.
  const id = typeof row.requestId === 'string' ? row.requestId : typeof row.uuid === 'string' ? row.uuid : null;
  if (id) {
    if (state.seen.has(id)) return;
    state.seen.add(id);
  }
  // TOK-B — istek sayacı TEKİLLEŞTİRMEDEN SONRA artar (aynı istek deftere iki kez
  // düşerse mega-oturum freni erken tetiklenirdi: sayı ölçüm değil şişme olurdu).
  state.requests += 1;
  const model = typeof msg.model === 'string' ? msg.model : 'unknown';
  const speed = typeof u.speed === 'string' ? u.speed : null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  // ephemeral_5m/1h ayrımı varsa onu kullan; yoksa toplamı 5dk kabul et (fiyat farkı
  // bilinmediğinde DÜŞÜK olanı seçmek uydurmadır → 5m ZATEN varsayılan TTL'dir).
  const w5 = cc ? num(cc.ephemeral_5m_input_tokens) : num(u.cache_creation_input_tokens);
  const w1 = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const add = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheWrite5mTokens: w5,
    cacheWrite1hTokens: cc ? w1 : 0,
  };
  const key = `${model}\u0000${speed || 'standard'}`;
  // ↑ (model, speed) bileşik anahtarı; ayraç NUL: model kimliği boşluk/tire
  // içerebilir, NUL içeremez → iki ayrı çift asla aynı anahtara çökmez.
  // 🪤 ADP-890: bu ayraç kaynağa HAM bayt olarak yazılmıştı; git dosyanın
  // TAMAMINI "binary" sayıp diff/blame'i kapatıyordu → artık kaçışla yazılır.
  const prev = state.byModel.get(key);
  state.byModel.set(key, {
    model,
    speed,
    usage: prev ? tokenCost.addUsage(prev.usage, add) : add,
  });
  // TOK-A — BU İSTEĞİN BAĞLAMI (girdi + önbellek okuma + önbellek yazma). Bir
  // sonraki istek aynı bağlamı yeniden okur (0.1×) ya da pencere kapandıysa
  // yeniden YAZAR (2.0×) → tazeleme ipucunun tek girdisi budur. Çıktı jetonu
  // bağlam DEĞİLDİR (üretildi, okunmayacak) → toplama girmez.
  const ctxTokens = add.inputTokens + add.cacheReadTokens + add.cacheWrite5mTokens + add.cacheWrite1hTokens;
  if (ctxTokens > 0) {
    const parsed = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    const atMs = Number.isFinite(parsed) ? parsed : null;
    const prevLast = state.lastRequest;
    // Defter eklemeli ve sıralıdır; yine de damgası OLAN satır geriye gitmesin
    // (bozuk/yeniden yazılmış defterde sıra garantisi yoktur). Damga yoksa son
    // görülen satır kazanır — "bilmiyorum"u eski bir damgaya tercih etmeyiz.
    if (!prevLast || atMs === null || prevLast.atMs === null || atMs >= prevLast.atMs) {
      state.lastRequest = { atMs, ctxTokens, model, speed };
    }
  }
}

/** state → [{model, speed, usage}] (deterministik: en çok jetondan aza). */
function rowsFromState(state) {
  if (!state) return [];
  return [...state.byModel.values()].sort((a, b) => tokenCost.totalTokens(b.usage) - tokenCost.totalTokens(a.usage));
}

/**
 * Pane'in ŞU ANKİ claude oturumunun kullanımı.
 *
 * 🔴 TOK-01 — "BULUNAMADI" ile "0 JETON" AYRI HÂLLERDİR. Eski sürüm ikisini de
 * boş model listesiyle döndürüyordu; kart `measured` bayrağını oturum+toplamın
 * MANTIKSAL VEYA'sından aldığı için, defteri bulunamayan bir oturum ekranda
 * dürüstçe "okunamadı" değil, GÜVENLE "0" diye görünüyordu (ölçüldü — TOK-01
 * öncesi tablo: sahte sessionId → cardMeasured=true, session "0"). Sabit sayıya
 * bakan kullanıcı onu doğru sanıyor: şikâyetin ta kendisi.
 *
 * @returns {{ measured:boolean, file:string|null, via:string, reason:string, models:Array }}
 *   reason: 'ok' | 'no-target' (cwd/sessionId yok) | 'ledger-missing' (dosya yok)
 *           | 'unreadable' (dosya var, okunamadı)
 */
function claudeSessionUsage({ cwd, sessionId }, home) {
  const r = transcriptProbe.resolveTranscript(cwd, sessionId, claudeHome(home));
  if (!r.file) return { measured: false, file: null, via: r.via, reason: 'no-target', models: [] };
  if (!r.found) return { measured: false, file: r.file, via: r.via, reason: 'ledger-missing', models: [] };
  const state = scanJsonlIncremental(r.file, newClaudeState, claudeRow);
  if (!state) return { measured: false, file: r.file, via: r.via, reason: 'unreadable', models: [] };
  return {
    measured: true,
    file: r.file,
    via: r.via,
    reason: 'ok',
    models: rowsFromState(state),
    // TOK-A — son isteğin künyesi (defterde hiç istek yoksa null KALIR).
    lastRequest: state.lastRequest || null,
    // TOK-B — bu oturumun istek sayısı (mega-oturum freninin girdisi).
    requests: state.requests || 0,
  };
}

/**
 * Bu cwd'nin claude proje dizin(ler)i.
 * ADP-306 (realpath) + TOK-01 (sürücü kasası · UNC · `\\?\` · sondaki ayraç ·
 * NFC · 200 tavanı) adaylarının tamamı — bkz. ledgerPath.cjs.
 */
function claudeProjectDirs(cwd, home) {
  if (!cwd) return [];
  return ledgerPath.projectDirCandidates(cwd, path.join(claudeHome(home), 'projects'));
}

/**
 * Bu cwd'deki TÜM claude oturumlarının kullanımı ("toplam" sütunu).
 * @returns {{ measured:boolean, files:number, models:Array, reason:string }}
 */
function claudeTotalUsage({ cwd }, home) {
  const files = [];
  for (const dir of claudeProjectDirs(cwd, home)) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        files.push({ file, mtimeMs: fs.statSync(file).mtimeMs });
      } catch {
        /* okunamayan dosya atlanır */
      }
    }
  }
  if (!files.length) return { measured: false, files: 0, models: [], reason: 'ledger-missing' };
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const capped = files.slice(0, MAX_FILES);
  const merged = new Map();
  for (const { file } of capped) {
    const state = scanJsonlIncremental(file, newClaudeState, claudeRow);
    for (const row of rowsFromState(state)) {
      const key = `${row.model}\u0000${row.speed || 'standard'}`;
      const prev = merged.get(key);
      merged.set(key, { ...row, usage: prev ? tokenCost.addUsage(prev.usage, row.usage) : row.usage });
    }
  }
  return {
    measured: true,
    reason: 'ok',
    files: capped.length,
    truncated: files.length > capped.length,
    models: [...merged.values()].sort((a, b) => tokenCost.totalTokens(b.usage) - tokenCost.totalTokens(a.usage)),
  };
}

// ---------------------------------------------------------------------------
// codex defteri
// ---------------------------------------------------------------------------

function codexHome(override) {
  return override || process.env.CREWPANE_CODEX_HOME || path.join(os.homedir(), '.codex');
}

function newCodexState() {
  // 🪤 total_token_usage KÜMÜLATİF → "son gördüğüm" tutulur, TOPLANMAZ.
  return { cwd: null, model: null, planType: null, bornAt: null, last: null };
}

function codexRow(state, row) {
  if (!row || typeof row !== 'object') return;
  const p = row.payload && typeof row.payload === 'object' ? row.payload : null;
  if (row.type === 'session_meta' && p) {
    if (typeof p.cwd === 'string') state.cwd = p.cwd;
    if (typeof p.timestamp === 'string') {
      const ms = Date.parse(p.timestamp);
      if (Number.isFinite(ms)) state.bornAt = ms;
    }
    return;
  }
  if (row.type === 'turn_context' && p && typeof p.model === 'string') {
    state.model = p.model; // son tur hangi modelde bittiyse o
    return;
  }
  if (row.type === 'event_msg' && p && p.type === 'token_count') {
    const info = p.info && typeof p.info === 'object' ? p.info : null;
    const t = info && info.total_token_usage;
    if (t && typeof t === 'object') state.last = t;
    const rl = p.rate_limits;
    if (rl && typeof rl === 'object' && typeof rl.plan_type === 'string') state.planType = rl.plan_type;
  }
}

/** codex kümülatif sayacı → ortak usage şekli. */
function codexUsage(t) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const cached = num(t.cached_input_tokens);
  // 🪤 codex'te cached_input_tokens, input_tokens'ın ALT KÜMESİDİR (ölçüldü:
  // total = input + output). Çıkarılmazsa önbellekli jeton İKİ KEZ sayılır.
  return {
    inputTokens: Math.max(0, num(t.input_tokens) - cached),
    outputTokens: num(t.output_tokens),
    cacheReadTokens: cached,
    cacheWrite5mTokens: num(t.cache_write_input_tokens),
    cacheWrite1hTokens: 0,
  };
}

/** `~/.codex/sessions` altındaki rollout dosyaları (yeniden eskiye, sınırlı). */
function codexRolloutFiles(home, limit = MAX_FILES) {
  const root = path.join(codexHome(home), 'sessions');
  const out = [];
  const cutoff = Date.now() - CODEX_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // YYYY / MM / DD — yeniden eskiye in.
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const st = fs.statSync(full);
          if (st.mtimeMs >= cutoff) out.push({ file: full, mtimeMs: st.mtimeMs });
        } catch {
          /* atla */
        }
      }
      if (out.length >= limit * 4) return; // kaba fren; aşağıda kesin sıralama var
    }
  };
  walk(root, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

/**
 * Codex pane'i için kullanım. Codex bize oturum kimliği VERMEZ → eşleme
 * cwd + pane açılış zamanı ile yapılır ve `match:'heuristic'` diye raporlanır.
 */
function codexUsageFor({ cwd, startedAt }, home) {
  const files = codexRolloutFiles(home);
  if (!files.length) return { measured: false, session: [], total: [], match: 'none', files: 0 };
  let real = cwd;
  try {
    real = fs.realpathSync(String(cwd));
  } catch {
    /* cwd yok → ham hâli */
  }
  const mine = [];
  for (const { file, mtimeMs } of files) {
    const state = scanJsonlIncremental(file, newCodexState, codexRow);
    if (!state || !state.last) continue;
    if (state.cwd !== cwd && state.cwd !== real) continue;
    mine.push({ file, mtimeMs, state });
  }
  if (!mine.length) return { measured: false, session: [], total: [], match: 'none', files: files.length };

  const rowOf = (state) => ({ model: state.model || 'unknown', usage: codexUsage(state.last) });
  // Toplam: her oturumun KENDİ kümülatif sayacı toplanır (model bazında).
  const merged = new Map();
  for (const m of mine) {
    const r = rowOf(m.state);
    const prev = merged.get(r.model);
    merged.set(r.model, { model: r.model, usage: prev ? tokenCost.addUsage(prev.usage, r.usage) : r.usage });
  }
  // Bu oturum: pane açıldıktan SONRA doğmuş en yeni defter; yoksa en yeni defter
  // (ve match 'heuristic' kalır — çağıran bunu ekranda "yaklaşık" diye gösterir).
  const slackMs = 60_000;
  const born = startedAt ? mine.filter((m) => (m.state.bornAt ?? m.mtimeMs) >= startedAt - slackMs) : [];
  const pick = (born.length ? born : mine)[0];
  return {
    measured: true,
    files: mine.length,
    match: born.length ? 'started-after-pane' : 'heuristic',
    planType: pick.state.planType || null,
    sessionFile: pick.file,
    session: [rowOf(pick.state)],
    total: [...merged.values()].sort((a, b) => tokenCost.totalTokens(b.usage) - tokenCost.totalTokens(a.usage)),
  };
}

// ---------------------------------------------------------------------------
// Fatura kipi — "bu motorun parasını KİM ödüyor?"
// ---------------------------------------------------------------------------

/** JSON dosyasını sessizce oku (yoksa null). */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `a.b.c` yol okuması (ara düğüm yoksa undefined — throw ETMEZ). */
function pickPath(obj, dotted) {
  if (!obj || typeof obj !== 'object' || typeof dotted !== 'string' || !dotted) return undefined;
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

/**
 * Descriptor'daki fatura dosyası yolunu çöz. Yalnız BEYAN EDİLEN kökler tanınır
 * (`~` ev dizini, `$CODEX_HOME` motorun kendi evi); tanınmayan bir kök UYDURULMAZ,
 * `null` döner → fatura kipi 'unknown' kalır.
 */
function resolveBillingFile(spec, opts = {}) {
  if (typeof spec !== 'string' || !spec) return null;
  const [head, ...rest] = spec.split('/');
  if (head === '~') return path.join(os.homedir(), ...rest);
  if (head === '$CODEX_HOME') return path.join(codexHome(opts.codexHome), ...rest);
  if (path.isAbsolute(spec)) return spec;
  return null;
}

/** `contains:x` / `equals:x` — descriptor'daki abonelik eşleşme kuralı. */
function matchesRule(rule, value) {
  if (typeof rule !== 'string' || typeof value !== 'string') return false;
  const i = rule.indexOf(':');
  const op = i < 0 ? 'equals' : rule.slice(0, i);
  const arg = i < 0 ? rule : rule.slice(i + 1);
  if (op === 'contains') return value.includes(arg);
  return value === arg;
}

/**
 * @returns {{ mode:'subscription'|'api'|'vendor-hosted'|'unknown', plan:string|null, source:string }}
 *   🔴 'unknown' MEŞRU bir cevaptır — tahmin edip dolar uydurmaktansa "bilinmiyor".
 *
 * ENG-09 — motor adına göre `if` YOK: kaynak `descriptor.usage.billing`'ten gelir
 * (apiKeyEnv → vendorHosted → configFile+field → bilinmiyor). Kayıtsız motor ya da
 * fatura beyanı olmayan motor 'motor desteklenmiyor' der; bu da bir CEVAPTIR, tahmin değil.
 *
 * ENG-16 — 4. KİP: `vendor-hosted`. Kimliksiz koşan bir motor SATICININ kendi bedava
 * sunucusundan geçiyor olabilir (opencode ölçümü). Eski üç kipten hangisi seçilse
 * YALAN olurdu; artık ölçülüp SÖYLENİYOR (ayrıntı + rozet cümlesi: engineBilling.cjs).
 * Sıra ÖNEMLİ: anahtar env'de ise kapı devrede değildir, o yüzden apiKeyEnv ÖNCE bakılır.
 */
function billingFor(engine, opts = {}) {
  const env = opts.env || process.env;
  const registry = opts.registry || engineRegistry;
  const desc = typeof engine === 'string' && engine ? registry.getEngine(engine) : null;
  const b = desc && desc.usage && desc.usage.billing ? desc.usage.billing : null;
  if (!b) return { mode: 'unknown', plan: null, source: 'motor desteklenmiyor' };

  // API anahtarı ortamda ise faturayı O öder (abonelik değil) — CLI'nin çözüm sırası.
  if (b.apiKeyEnv && env[b.apiKeyEnv]) return { mode: 'api', plan: null, source: b.apiKeyEnv };

  // ENG-16 — satıcı kapısı BEYAN EDİLMİŞSE ölç. `true` ise kip 4. değerdir; `null`
  // (ölçülemedi) ise KARAR VERİLMEZ ve akış aşağıdaki config yoluna devam eder.
  if (b.vendorHosted) {
    const vh = engineBilling.vendorHostedState(engine, { ...opts, env, registry });
    if (vh.vendorHosted === true) {
      return { mode: 'vendor-hosted', plan: null, source: vh.reason, vendorLabel: vh.vendorLabel, disclosure: vh.disclosure };
    }
    if (vh.vendorHosted === false && !b.configFile) {
      return { mode: 'api', plan: null, source: vh.reason };
    }
  }

  // Çağıran/test yolu ezebilir (descriptor hangi opts anahtarını tanıdığını SÖYLER).
  const override = b.overrideOpt ? opts[b.overrideOpt] : null;
  const file = override || resolveBillingFile(b.configFile, opts);
  const cfg = file ? readJson(file) : null;
  const value = pickPath(cfg, b.field);
  if (typeof value === 'string') {
    if (matchesRule(b.subscriptionWhen, value)) {
      const plan = b.planField ? pickPath(cfg, b.planField) : null;
      return { mode: 'subscription', plan: typeof plan === 'string' ? plan : null, source: b.sourceLabel };
    }
    return { mode: 'api', plan: null, source: b.sourceLabel };
  }
  return { mode: 'unknown', plan: null, source: 'ölçülemedi' };
}

// ---------------------------------------------------------------------------
// ENG-09 — KULLANIM ADAPTÖRLERİ ("tahmin yok" sözleşmesi burada yaşar)
// ---------------------------------------------------------------------------
//
// 🔴 SÖZLEŞME (ENG-R3 §10.2 karar B + ENG-R2 §5.4): bir motorun kullanımını
// ÖLÇEMİYORSAK kart "bilinmiyor" der. TAHMİN YOK: prompt uzunluğundan jeton
// kestirimi, "muhtemelen bu model" varsayımı, fiyat tablosunda olmayan modele
// sahte $0 — hepsi YASAK. Ölçülmemiş bir sayıyı göstermek, hiç göstermemekten
// KÖTÜDÜR: kullanıcı ekrandaki rakama güvenir (ADP-887 → TOK-01 şikâyeti).
//
// İki katman:
//   • OKUYUCU (`LEDGER_READERS`) — bir defterin NASIL bulunup ayrıştırıldığı.
//     Motora özel olan tek yer burasıdır ve descriptor `usage.reader` ile SEÇER.
//   • ADAPTÖR (`USAGE_ADAPTERS`) — `usage.kind`ın ANLAMI: hangi kapsamlar var,
//     eşleşme ne kadar güçlü (`match`), kullanıcıya hangi SEVİYE yazılır.
//
// Adaptörlerin ortak dönüş şekli (kind'den bağımsız):
//   { measured, match, reason,
//     session: { models, measured, reason, file, via },
//     total:   { models, measured, reason, files },
//     plan, lastRequest, requests }

/** Ölçülemeyen kapsam — sayı YOK, gerekçe VAR. */
function unmeasuredScope(reason) {
  return { models: [], measured: false, reason, file: null, via: null, files: 0 };
}

/** Hiçbir rakam üretmeyen adaptör sonucu (tek yerden, ki dallar sapmasın). */
function unmeasuredResult(reason, match = 'none') {
  return {
    measured: false,
    match,
    reason,
    session: unmeasuredScope(reason),
    total: unmeasuredScope(reason),
    plan: null,
    lastRequest: null,
    requests: 0,
  };
}

/**
 * Defter okuyucuları — descriptor `usage.reader` bunlardan birini SEÇER.
 * Yeni bir motorun defteri buraya bir kayıt olarak eklenir; `usageForPane`
 * ve kart DEĞİŞMEZ.
 */
const LEDGER_READERS = Object.freeze({
  // claude: oturum kimliği BİZİM (withSessionId) → dosya kesin; satırlar per-line
  // toplanır ve requestId ile TEKİLLEŞTİRİLİR (tuzak dosya başlığında).
  'claude-jsonl': Object.freeze({
    session: (pane, opts) =>
      claudeSessionUsage({ cwd: pane.cwd, sessionId: pane.sessionId }, opts.claudeHome),
    total: (pane, opts) => claudeTotalUsage({ cwd: pane.cwd }, opts.claudeHome),
  }),
  // codex: pane-başına oturum kimliği YOK; kümülatif sayacın SONUNCUSU alınır
  // (toplanırsa maliyet katlanır) ve eşleme cwd + açılış zamanı penceresiyle olur.
  'codex-rollout': Object.freeze({
    window: (pane, opts) => codexUsageFor({ cwd: pane.cwd, startedAt: pane.startedAt }, opts.codexHome),
  }),
});

/** `cli-report` çıktısının normalleştirilmesi — UYDURMA YOK: şekil bozuksa null. */
function normalizeReportRows(rows) {
  if (!Array.isArray(rows)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object' || !r.usage || typeof r.usage !== 'object') return null;
    out.push({
      model: typeof r.model === 'string' && r.model ? r.model : 'unknown',
      speed: typeof r.speed === 'string' ? r.speed : null,
      usage: {
        inputTokens: num(r.usage.inputTokens),
        outputTokens: num(r.usage.outputTokens),
        cacheReadTokens: num(r.usage.cacheReadTokens),
        cacheWrite5mTokens: num(r.usage.cacheWrite5mTokens),
        cacheWrite1hTokens: num(r.usage.cacheWrite1hTokens),
      },
    });
  }
  return out;
}

const USAGE_ADAPTERS = Object.freeze({
  /** KESİN: bizim bastığımız oturum kimliğiyle eşleşen defter (bugün claude). */
  'session-ledger': Object.freeze({
    level: 'exact',
    // Bu sınıf İSTEK BAŞINA bağlam ölçebilir (defterde her istek ayrı satır +
    // damga) → TOK-A tazeleme ipucu ve TOK-B dağıtım politikası burada ANLAMLI.
    perRequestContext: true,
    measure({ desc, pane, opts }) {
      const reader = LEDGER_READERS[desc.usage.reader];
      if (!reader || typeof reader.session !== 'function' || typeof reader.total !== 'function') {
        return unmeasuredResult('reader-missing');
      }
      const s = reader.session(pane, opts);
      const t = reader.total(pane, opts);
      return {
        measured: s.measured || t.measured,
        match: 'session-id',
        reason: s.reason,
        session: { models: s.models, measured: s.measured, reason: s.reason, file: s.file, via: s.via },
        total: { models: t.models, measured: t.measured, reason: t.reason, files: t.files || 0 },
        plan: null,
        // TOK-A — tazeleme ipucunun tek girdisi; yalnız bu sınıfta VARDIR.
        lastRequest: s.lastRequest || null,
        requests: s.requests || 0,
      };
    },
  }),

  /** YAKLAŞIK: cwd + pane açılış zamanı penceresiyle eşleşen defter (bugün codex). */
  'time-window': Object.freeze({
    level: 'approx',
    perRequestContext: false,
    measure({ desc, pane, opts }) {
      const reader = LEDGER_READERS[desc.usage.reader];
      if (!reader || typeof reader.window !== 'function') return unmeasuredResult('reader-missing');
      const c = reader.window(pane, opts);
      const reason = c.measured ? 'ok' : 'ledger-missing';
      return {
        measured: c.measured,
        match: c.match,
        reason,
        session: { models: c.session, measured: c.measured, reason, file: c.sessionFile || null, via: c.match },
        total: { models: c.total, measured: c.measured, reason, files: c.files || 0 },
        plan: c.planType || null,
        // 🔴 Bu sınıfta SON İSTEĞİN bağlamı ölçülemez (defterde istek ayrımı yok) →
        // `lastRequest` null KALIR; kart tazeleme/bayat-önbellek satırını BASMAZ.
        // Ölçülmeyeni göstermek kartın dürüstlük sözleşmesini bozardı.
        lastRequest: null,
        requests: 0,
      };
    },
  }),

  /**
   * MOTORUN KENDİ RAPORU (amp `threads usage`, crush `stats` sınıfı). Bu görevde
   * gerçek motor BAĞLANMADI: dal iskelet + testli. Raporu KİM koşturacaksa
   * (`opts.runUsageReport`) enjekte eder — tokenUsage burada süreç ÇALIŞTIRMAZ
   * (main dışı bağlamda spawn etmek hem yan etki hem güvenlik yüzeyidir).
   * Koşucu yoksa / çıktı beklenen şekilde değilse → ölçülmedi, TAHMİN YOK.
   */
  'cli-report': Object.freeze({
    level: 'reported',
    perRequestContext: false,
    measure({ desc, pane, opts }) {
      const report = desc.usage.report;
      if (!report || !Array.isArray(report.argv)) return unmeasuredResult('report-not-declared');
      const run = typeof opts.runUsageReport === 'function' ? opts.runUsageReport : null;
      if (!run) return unmeasuredResult('report-unavailable');
      let raw;
      try {
        raw = run({ engine: desc.id, argv: report.argv, cwd: pane.cwd, pane });
      } catch {
        return unmeasuredResult('report-failed');
      }
      if (!raw || typeof raw !== 'object') return unmeasuredResult('report-unreadable');
      const session = normalizeReportRows(raw.session);
      // Raporun "toplam" kapsamı yoksa UYDURULMAZ: o kapsam ölçülmedi kalır.
      const total = raw.total === undefined ? null : normalizeReportRows(raw.total);
      if (!session) return unmeasuredResult('report-unreadable');
      return {
        measured: true,
        match: 'cli-report',
        reason: 'ok',
        session: { models: session, measured: true, reason: 'ok', file: null, via: 'cli-report' },
        total: total
          ? { models: total, measured: true, reason: 'ok', files: 0 }
          : unmeasuredScope('scope-not-reported'),
        plan: typeof raw.plan === 'string' ? raw.plan : null,
        lastRequest: null,
        requests: 0,
      };
    },
  }),

  /**
   * AGY-04 — KOŞUNUN KENDİ ÇIKTI ZARFI (bugün antigravity `--output-format
   * json|stream-json`). Defter YOKTUR: sayaç koşunun çıktısındadır ve o çıktıyı
   * yalnız işi KOŞTURAN taraf görür.
   *
   * `cli-report`tan iki farkı var ve ikisi de bilinçli:
   *   • ÇALIŞTIRACAK BİR RAPOR KOMUTU YOK ve OLMAMALI — zarfı üretmenin tek yolu
   *     bir MODEL TURU koşturmaktır; jeton ölçmek için jeton yakmak saçmadır.
   *     Bu yüzden burada `runUsageReport` benzeri bir koşucu ÇAĞRILMAZ.
   *   • Sayaç OTURUM KİMLİĞİYLE KESİN eşleşir (`conversation_id` her zarfta var)
   *     ⇒ seviye 'exact', 'reported' değil.
   *
   * Zarfı süpervizör `opts.runEnvelope` ile ENJEKTE eder (şekil:
   * `agyStreamReader.toUsageEnvelope()` çıktısı). Zarf yoksa TAHMİN YOK — kart
   * "bilinmiyor" der ve gerekçesi bu motorun ölçülmüş sınırıdır: interaktif pane
   * zarf BASMAZ (`output.printModeOnly`).
   */
  'run-envelope': Object.freeze({
    level: 'exact',
    // Zarf koşu TOPLAMINI verir; istek başına satır YOKTUR ⇒ TOK-A tazeleme ipucu
    // bu sınıfta ÜRETİLEMEZ (ölçülmeyeni göstermemek kartın sözleşmesi).
    perRequestContext: false,
    measure({ pane, opts }) {
      const raw =
        typeof opts.runEnvelope === 'function'
          ? (() => {
              try {
                return opts.runEnvelope(pane);
              } catch {
                return null;
              }
            })()
          : opts.runEnvelope;
      if (!raw || typeof raw !== 'object') return unmeasuredResult('envelope-not-recorded');
      const session = normalizeReportRows(raw.session);
      if (!session) return unmeasuredResult('envelope-unreadable');
      return {
        measured: true,
        match: 'conversation-id',
        reason: 'ok',
        session: { models: session, measured: true, reason: 'ok', file: null, via: 'run-envelope' },
        // "TÜM OTURUMLAR" kapsamı bu sınıfta YOKTUR: elimizde yalnız BU koşunun
        // zarfı var, motorun geçmiş koşularını okuyan bir defter yok.
        total: unmeasuredScope('scope-not-in-envelope'),
        plan: null,
        lastRequest: null,
        requests: 0,
      };
    },
  }),

  /** ÖLÇÜLEMEZ: kabuk pane'i ya da kullanım defteri beyan etmeyen motor. */
  none: Object.freeze({
    level: 'none',
    perRequestContext: false,
    measure() {
      return unmeasuredResult('engine-not-measurable');
    },
  }),
});

/**
 * Bu pane hangi adaptörle ölçülür? Kayıtsız motor / `usage` beyanı olmayan motor /
 * tanınmayan `kind` → 'none'. Tanımadığımız bir motor sessizce ÖLÇÜLEBİLİR
 * sayılmaz (ENG-R3 §14-R1'in jeton yüzeyindeki karşılığı).
 */
function usageAdapterFor(engine, opts = {}) {
  const registry = opts.registry || engineRegistry;
  const desc = typeof engine === 'string' && engine ? registry.getEngine(engine) : null;
  const declared = desc && desc.usage && typeof desc.usage.kind === 'string' ? desc.usage.kind : null;
  const kind = declared && USAGE_ADAPTERS[declared] ? declared : 'none';
  return { desc, kind, adapter: USAGE_ADAPTERS[kind] };
}

// ---------------------------------------------------------------------------
// Tek giriş noktası — main.js'in çağırdığı
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` (yerel) — tanıtım fiyatı penceresi için. */
function todayIso(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Pane → infobox verisi.
 *
 * ENG-09 — burada artık MOTOR ADI YOK: pane'in motoru descriptor'a, descriptor
 * `usage.kind`ı bir ADAPTÖRE çözülür. Yeni motor eklemek = descriptor kaydı
 * (+ gerekiyorsa bir okuyucu); bu fonksiyon ve kart değişmez.
 *
 * @param {{paneId, engine, cwd, sessionId, startedAt}} pane
 * @param {{registry?, claudeHome?, codexHome?, env?, at?, nowMs?, runUsageReport?, runEnvelope?}} opts
 * @returns tokenCost.summarize() çıktısı + ölçüm künyesi (seviye dahil)
 */
function usageForPane(pane = {}, opts = {}) {
  const { desc, kind, adapter } = usageAdapterFor(pane.engine, opts);
  const engine = desc ? desc.id : null;
  const billing = billingFor(engine, opts);
  const at = opts.at || todayIso();
  const m = adapter.measure({ desc, pane, opts });
  const base = {
    paneId: pane.paneId || null,
    billingSource: billing.source,
    // ENG-09 — ÖLÇÜM SEVİYESİ KULLANICIYA GÖRÜNÜR (bugünkü `measured` bayrağının
    // genelleşmiş hâli): 'exact' (oturum kimliğiyle) · 'approx' (zaman penceresi)
    // · 'reported' (motorun kendi raporu) · 'none' (ölçülemez → "bilinmiyor").
    usageKind: kind,
    usageLevel: adapter.level,
  };
  if (kind === 'none') {
    // Ölçülecek bir kullanım kaynağı YOK — kart bunu dürüstçe yazar, 0 BASMAZ.
    // İki ayrı hâl ayrışır: kabuk pane'i (motor yok) ↔ kayıtlı ama defteri
    // beyan edilmemiş motor (ölçüm yolu yok). İkincisine "bu bir kabuk" demek
    // yanlış bilgi olurdu.
    return {
      ...base,
      ...tokenCost.summarize({ engine: engine || pane.engine || null, billing: billing.mode, measured: false, at }),
      plan: billing.plan,
      note: desc ? 'usage-not-measurable' : 'engine-not-measurable',
    };
  }
  const out = {
    ...base,
    ...tokenCost.summarize({
      engine,
      billing: billing.mode,
      measured: m.measured,
      models: m.session.models,
      // 🔴 TOK-01 — ESKİDEN: `t.measured ? t.models : s.models`. Toplam defteri
      // okunamadığında OTURUMUN rakamı "TÜM OTURUMLAR" diye gösteriliyordu;
      // iki farklı kapsam aynı sayıyı yazınca kullanıcı toplamı doğru sanıyordu.
      // Artık her kapsam KENDİ ölçümünü taşır, ölçülemeyen kapsam bunu SÖYLER.
      totalModels: m.total.models,
      sessionMeasured: m.session.measured,
      totalMeasured: m.total.measured,
      sessionReason: m.session.reason,
      totalReason: m.total.reason,
      at,
      // TOK-A — tazeleme ipucunun girdisi: SON isteğin bağlamı + saati. Yalnız
      // `session-ledger` sınıfında ölçülür; diğerlerinde null → `refresh` null
      // kalır ve kart hiçbir satır basmaz (ölçülmeyen tavsiye verilmez).
      lastRequest: m.lastRequest,
      nowMs: typeof opts.nowMs === 'number' ? opts.nowMs : Date.now(),
    }),
    // Plan: fatura kaynağı söylediyse o, yoksa defterin söylediği (codex rate_limits).
    plan: billing.plan || m.plan || null,
    sessionFile: m.session.file || null,
    // 🔴 `sessionFound` BU OTURUMUN defteri demektir — toplamın okunabilmesi bu
    // soruyu cevaplamaz (dağıtım politikası buna bakar: main.js:1190).
    sessionFound: m.session.measured,
    sessionVia: m.session.via,
    sessionReason: m.session.reason,
    totalFiles: m.total.files || 0,
    match: m.match,
  };
  // TOK-B — dağıtım politikasının girdileri (kartın gösterdiği ÖLÇÜMÜN aynısı).
  // 🔴 Bu iki alan YALNIZ istek-başı bağlamı ölçebilen sınıfta VARDIR ve yoksa
  // hiç YAZILMAZ — `0`/`null` yazmak "ölçtüm, sıfır çıktı" demektir; oysa doğru
  // cevap "bu motorun defteri bu soruyu cevaplamıyor"dur. (codex/cli-report'ta
  // ne istek ayrımı ne son isteğin bağlamı var → politika orada karar üretemez.)
  if (adapter.perRequestContext) {
    out.sessionRequests = m.requests;
    out.lastRequest = m.lastRequest;
  }
  return out;
}

module.exports = {
  MAX_FILES,
  scanJsonlIncremental,
  resetCache,
  claudeSessionUsage,
  claudeTotalUsage,
  codexRolloutFiles,
  codexUsageFor,
  codexUsage,
  billingFor,
  todayIso,
  usageForPane,
  // ENG-09 — adaptör yüzeyi (test + ileride ENG-10 rozet girdisi).
  LEDGER_READERS,
  USAGE_ADAPTERS,
  usageAdapterFor,
};
