#!/usr/bin/env node
// MCP-LAZY-01 (KATMAN 2) — "ILK CAGRIDA BASLAT" COGULLAYICI VEKILI.
//
// ─────────────────────────────────────────────────────────────────────────────
// NEDEN BU DOSYA VAR — VE NEDEN SERVIS BASINA BIR VEKIL DEGIL
//
// claude, `--mcp-config`'teki server'larin HEPSINI oturum basinda acar (MCP-COST-01
// olcumu: 16 pane'in 16'sinda da 4 servisin dordu ayakta, cogu hic cagrilmadan).
// "Ilk cagrida baslat" bu yuzden urunun kendi karari degil — araya bir vekil koymak
// gerekir. Servis BASINA bir vekil koymak ise KAZANC URETMEZ, olculdu:
//
//     bos bir node stdio sureci  =  33 MB  (3 kosu, oturmus RSS)
//     erteledigi MCP server'lari =  25-37 MB
//
// Yani tembellestiricinin taban maliyeti, erteledigi isin maliyeti kadar. Kazanc
// ancak TEK vekil DORT servisi cogullarsa gelir: 33 MB vs ~120 MB (-%72).
// Bu dosya o tek vekildir.
//
// ⚠️ BILINCLI TAKAS — ARAC ADLARI DEGISIR. claude bir MCP aracini modele
// `mcp__<server>__<tool>` diye verir. Dort servis TEK server'da toplanınca adlar
// `mcp__vercel__getAuthUser` yerine `mcp__integrations__vercel_getAuthUser` olur.
// Bunu gizlemiyoruz: urunde arac adina yaslanan bir izin listesi/kod yok (arandi),
// model araci zaten arayarak buluyor, ve kapali anahtarla (CREWPANE_MCP_LAZY=0)
// eski adlar birebir geri geliyor.
//
// ─────────────────────────────────────────────────────────────────────────────
// NASIL CALISIR
//
//   initialize   → aninda cevap (hicbir cocuk dogmaz)
//   tools/list   → DISK ONBELLEGINDEN cevaplanir (hicbir cocuk dogmaz)
//                  onbellek yoksa: o servis BIR KEZ acilir, listesi yazilir, KAPATILIR
//   tools/call   → o aracin servisi ILK KEZ burada dogar (el sikisir), istek iletilir
//   bosta        → N dk cagrilmayan cocuk iner; sonraki cagrida geri gelir
//
// ─────────────────────────────────────────────────────────────────────────────
// GUVENLIK
//   • Manifest SIR TASIMAZ — yalniz env DEGISKEN ADLARI yazar. Gercek degerler
//     vekilin KENDI env'inde durur (claude onlari pane env'inden genisletir) ve
//     her cocuga YALNIZ kendi anahtari verilir (MCP-COST-01/ADP-585 Kural 2 aynen).
//   • `command`/`args` manifest'ten gelir, ISTEKTEN ASLA — model bir ikili
//     calistiramaz (mcpProbe'un ayni durusu).
//   • stdout YALNIZ protokol; her log stderr'e (aksi hâlde JSON-RPC bozulur).
//
// BAGIMSIZ: yalniz node builtin'leri require eder → paketleme yuzeyi tek dosyadir.
// Calistir: node --test electron/mcpLazyProxy.test.cjs

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SERVER_NAME = 'crewpane-integrations-lazy';
const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_IDLE_MS = 10 * 60 * 1000;   // 10 dk — soguk baslangic 0,12-0,68 sn olculdu
const HANDSHAKE_TIMEOUT_MS = 45000;       // npx ilk indirmeyi de tolere eder (mcpProbe emsali)
// ISINMA ayri ve DAHA KISA bir zaman asimi ister. Olculdu (09.09, gercek filo):
// bozuk bir servis (posthog/mcp-remote OAuth kesfinde asili kaldi) isinmayi 45 sn
// bloke etti ve `tools/list` 46,6 sn surdu — claude bu sure boyunca ACILMAZ.
// Isinma SIRAYLA degil PARALEL yapilir ve 20 sn'de kesilir: bir bozuk servis
// digerlerinin listesini geciktiremez.
const WARM_TIMEOUT_MS = 20000;
const CALL_TIMEOUT_MS = 120000;
const MAX_TOOL_NAME = 64;                 // MCP arac adi siniri
// Soguk baslangic notu esigi. Olculdu (gercek servisler, 09.09): coolify 112 ms,
// sentry 708 ms, vercel 1.466 ms. 500 ms'in altini kimse fark etmez — not yazmak
// gurultudur; ustunu ADIYLA soylemek, sessiz bir gecikmeden iyidir.
const COLD_NOTE_MS = 500;

function logErr(msg) {
  try { process.stderr.write(`[mcp-lazy] ${msg}\n`); } catch { /* stderr kapali */ }
}

/** Onbellek anahtari: komut+argumanlar. Surum sabitlemesi degisirse onbellek DUSER. */
function cacheKey(svc) {
  const h = crypto.createHash('sha1').update(JSON.stringify([svc.command, svc.args || []])).digest('hex');
  return `${String(svc.id).replace(/[^A-Za-z0-9_.-]/g, '_')}-${h.slice(0, 12)}.json`;
}

function readCache(dir, svc) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, cacheKey(svc)), 'utf8'));
    return Array.isArray(raw && raw.tools) ? raw.tools : null;
  } catch {
    return null;
  }
}

function writeCache(dir, svc, tools) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, cacheKey(svc));
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ service: svc.id, capturedAt: Date.now(), tools }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);          // atomik: yarim onbellek okunmaz
    return true;
  } catch {
    return false;                       // onbellek yazilamadi → bir dahaki sefere yine isinir
  }
}

/**
 * Cogullanmis arac adi. `<servis>_<arac>`; 64 karakteri asarsa arac adi kisaltilir
 * ve KISALTMA HASH'LE tekillestirilir (iki uzun ad ayni ada dusmesin).
 */
function proxiedName(serviceId, toolName) {
  const raw = `${serviceId}_${toolName}`;
  if (raw.length <= MAX_TOOL_NAME) return raw;
  const tag = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 6);
  return `${raw.slice(0, MAX_TOOL_NAME - 7)}_${tag}`;
}

// ─── cocuk sureç yonetimi ────────────────────────────────────────────────────

/**
 * Bir servisin CANLI baglantisi. `start()` sureci dogurur + el sikisir; `call()`
 * JSON-RPC iletir; `stop()` indirir. Tekrar `start()` cagrilabilir (bosta kapatma
 * sonrasi geri gelme yolu budur).
 */
function createChild(svc, deps) {
  const spawnFn = deps.spawn || spawn;
  const idleMs = deps.idleMs;
  let proc = null;
  let buf = '';
  let nextId = 1;
  const pending = new Map();
  let starting = null;
  let idleTimer = null;

  function clearIdle() {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  }

  function armIdle() {
    clearIdle();
    if (!idleMs || idleMs <= 0) return;   // 0 = hic indirme (kontrol kolu)
    idleTimer = setTimeout(() => {
      logErr(`${svc.id}: ${Math.round(idleMs / 60000)} dk bosta → surec indiriliyor`);
      stop();
    }, idleMs);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  }

  function stop() {
    clearIdle();
    const p = proc;
    proc = null;
    starting = null;
    buf = '';
    for (const [, entry] of pending) entry.reject(new Error('server kapandi'));
    pending.clear();
    if (!p) return;
    try { p.kill('SIGTERM'); } catch { /* zaten olmus */ }
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ok */ } }, 2000);
    if (typeof t.unref === 'function') t.unref();
  }

  function onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || msg.id === undefined || msg.id === null) return;   // bildirim → yoksay
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    entry.resolve(msg);
  }

  function send(obj) {
    if (!proc || !proc.stdin || !proc.stdin.writable) throw new Error('server yazilabilir degil');
    proc.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  function request(method, params, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} zaman asimi (${timeoutMs} ms)`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pending.set(id, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { send({ jsonrpc: '2.0', id, method, params: params || {} }); } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  function start() {
    if (proc) { armIdle(); return Promise.resolve(); }
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const env = { ...(deps.baseEnv || {}) };
      // Kural 2 — HER COCUK YALNIZ KENDI ANAHTARINI GORUR. Vekil dordunu de
      // tasiyor (claude oyle genisletti) ama coguldan cocuga DAR gecer.
      for (const name of svc.envKeys || []) {
        const v = deps.secretEnv ? deps.secretEnv[name] : undefined;
        if (typeof v === 'string' && v) env[name] = v;
      }
      // The proxy may itself run under Electron; do not leak its mode to npx
      // or other children. Only Electron launchers explicitly need this flag.
      delete env.ELECTRON_RUN_AS_NODE;
      if (svc.runAsNode === true) env.ELECTRON_RUN_AS_NODE = '1';
      // `${VAR}` GENISLETMESI — claude'un config'te yaptigini vekil de yapar. Bazi
      // katalog girdileri anahtari ARGUMANDA tasir (`mcp-remote ... --header
      // Authorization:Bearer ${X}`); genisletmezsek server literal `${X}` ile 401
      // alir ve ariza SESSIZ olur ("bagli ama hep yetkisiz"). YALNIZ bu servisin
      // KENDI beyan ettigi anahtarlar genisletilir → komsunun sirri argv'ye DUSEMEZ.
      const allowed = new Set(svc.envKeys || []);
      const expand = (raw) => String(raw).replace(/\$\{([A-Za-z0-9_]+)\}/g, (whole, n) => (
        allowed.has(n) && typeof env[n] === 'string' ? env[n] : whole
      ));
      const args = (Array.isArray(svc.args) ? svc.args : []).map(expand);
      let child;
      try {
        child = spawnFn(svc.command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          cwd: svc.cwd || undefined,
        });
      } catch (err) {
        starting = null;
        reject(new Error(`baslatilamadi: ${err.message}`));
        return;
      }
      proc = child;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) onLine(line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => logErr(`${svc.id} stderr: ${String(c).trim().slice(0, 400)}`));
      child.on('exit', (code) => {
        logErr(`${svc.id}: surec bitti (code=${code})`);
        if (proc === child) stop();
      });
      child.on('error', (err) => logErr(`${svc.id}: ${err.message}`));

      request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: SERVER_NAME, version: '1.0.0' },
      }, HANDSHAKE_TIMEOUT_MS)
        .then(() => {
          try { send({ jsonrpc: '2.0', method: 'notifications/initialized' }); } catch { /* ok */ }
          armIdle();
          resolve();
        })
        .catch((err) => {
          stop();
          reject(err);
        });
    }).finally(() => { starting = null; });
    return starting;
  }

  return {
    id: svc.id,
    get alive() { return !!proc; },
    get pid() { return proc ? proc.pid : null; },
    start,
    stop,
    async call(method, params, timeoutMs) {
      await start();
      armIdle();
      const res = await request(method, params, timeoutMs || CALL_TIMEOUT_MS);
      armIdle();
      return res;
    },
  };
}

// ─── vekil ───────────────────────────────────────────────────────────────────

/**
 * Manifest → calisir vekil. Saf DI: `spawn`, `now`, `out` enjekte edilebilir →
 * `node --test` gercek surec dogurmadan kosar.
 */
function createProxy(manifest, deps = {}) {
  const services = (Array.isArray(manifest.services) ? manifest.services : []).filter(
    (s) => s && typeof s.id === 'string' && typeof s.command === 'string' && s.command,
  );
  const cacheDir = manifest.cacheDir || '';
  const idleMs = Number.isFinite(manifest.idleMs) ? manifest.idleMs : DEFAULT_IDLE_MS;
  const secretEnv = deps.env || process.env;
  const children = new Map();
  const routes = new Map();     // cogullanmis ad → {serviceId, toolName}
  let toolsCache = null;        // tam liste (union), bir kez hesaplanir

  function childFor(id) {
    if (!children.has(id)) {
      const svc = services.find((s) => s.id === id);
      children.set(id, createChild(svc, {
        spawn: deps.spawn,
        idleMs,
        baseEnv: deps.baseEnv || {},
        secretEnv,
      }));
    }
    return children.get(id);
  }

  /**
   * Bir servisin arac listesi. ONCE ONBELLEK (hicbir surec dogmaz). Onbellek yoksa
   * servis BIR KEZ acilir, listesi yazilir ve HEMEN KAPATILIR — "cagrilmadan surec
   * yok" sozu, ilk isinma disinda, boylece korunur.
   */
  async function toolsOf(svc) {
    const cached = deps.readCache ? deps.readCache(cacheDir, svc) : readCache(cacheDir, svc);
    if (cached) return { tools: cached, warmed: false };
    const child = childFor(svc.id);
    try {
      const res = await child.call('tools/list', {}, WARM_TIMEOUT_MS);
      const tools = (res && res.result && Array.isArray(res.result.tools)) ? res.result.tools : [];
      (deps.writeCache || writeCache)(cacheDir, svc, tools);
      return { tools, warmed: true };
    } catch (err) {
      logErr(`${svc.id}: arac listesi alinamadi — ${err.message}`);
      return { tools: [], warmed: true, error: err.message };
    } finally {
      // Isinma cagrisiydi: sureci BIRAKMA. Kullanici bir arac cagirmadi.
      child.stop();
    }
  }

  async function listTools() {
    if (toolsCache) return toolsCache;
    const out = [];
    routes.clear();
    // PARALEL isinma — bir bozuk servis digerlerini BEKLETMEZ (olculdu: sirali
    // isinmada tek bir asili server `tools/list`i 46,6 sn'ye cikardi).
    const warmed = await Promise.all(services.map((svc) => toolsOf(svc).then((r) => [svc, r])));
    for (const [svc, { tools }] of warmed) {
      for (const t of tools) {
        if (!t || typeof t.name !== 'string' || !t.name) continue;
        const name = proxiedName(svc.id, t.name);
        routes.set(name, { serviceId: svc.id, toolName: t.name });
        out.push({
          name,
          // Ajanin hangi servise dokundugunu ADINDAN once ACIKLAMADAN gormesi
          // icin servis adi one yazilir; gerisi server'in kendi metnidir.
          description: `[${svc.id}] ${typeof t.description === 'string' ? t.description : ''}`.trim(),
          inputSchema: t.inputSchema || { type: 'object' },
        });
      }
    }
    toolsCache = out;
    return out;
  }

  async function callTool(name, args) {
    if (!routes.size) await listTools();      // sifirdan baslayan bir oturum
    const route = routes.get(name);
    if (!route) {
      return {
        content: [{
          type: 'text',
          text: `bu pane'de "${name}" diye bir entegrasyon araci yok. `
            + 'Once crewpane_integrations ile hangi servislerin bu pane\'de acik oldugunu sor.',
        }],
        isError: true,
      };
    }
    const child = childFor(route.serviceId);
    const cold = !child.alive;
    const startedAt = Date.now();
    try {
      const res = await child.call('tools/call', { name: route.toolName, arguments: args || {} });
      const coldMs = Date.now() - startedAt;
      if (cold) logErr(`${route.serviceId}: soguk baslangic ${coldMs} ms (ilk cagri)`);
      if (res && res.error) {
        return { content: [{ type: 'text', text: `${route.serviceId}: ${res.error.message || 'hata'}` }], isError: true };
      }
      const result = (res && res.result) || { content: [{ type: 'text', text: 'bos cevap' }], isError: true };
      // SOGUK BASLANGIC GORUNURLUGU. Gecikme HISSEDILIR oldugunda (>= esik) ajana
      // AYRI bir icerik blogu olarak soylenir — cevabin kendi metnine karismaz, ama
      // ajan kullaniciya "ilk cagriydi, servis simdi ayakta" diyebilir. Sessiz bir
      // gecikme, kullaniciya "urun yavas" diye gorunur; adi konmus gecikme gorunmez.
      if (cold && coldMs >= COLD_NOTE_MS && Array.isArray(result.content)) {
        result.content = [...result.content, {
          type: 'text',
          text: `(${route.serviceId} bu pane'de ILK KEZ baslatildi — ${coldMs} ms. Sonraki cagrilar hizli; `
            + `${Math.round(idleMs / 60000)} dk kullanilmazsa surec iner ve bir sonraki cagrida geri gelir.)`,
        }];
      }
      return result;
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `${route.serviceId} bu pane'de baslatilamadi: ${err.message}. `
            + 'Anahtar/ayar eksik olabilir — Ayarlar → Entegrasyonlar\'dan "Baglantiyi dene".',
        }],
        isError: true,
      };
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg || {};
    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: '1.0.0' },
        },
      };
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return null;
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: await listTools() } };
    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
    if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
    if (method === 'tools/call') {
      const result = await callTool(params && params.name, params && params.arguments);
      return { jsonrpc: '2.0', id, result };
    }
    if (id === undefined || id === null) return null;
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `bilinmeyen metod: ${method}` } };
  }

  return {
    handle,
    listTools,
    callTool,
    services,
    /** Test/olcum icin: su an CANLI olan cocuk servisler. */
    liveServices: () => [...children.values()].filter((c) => c.alive).map((c) => c.id),
    stopAll: () => { for (const c of children.values()) c.stop(); },
  };
}

// ─── stdio dongusu (yalniz dogrudan calistirilinca) ──────────────────────────

function main(argv) {
  const manifestPath = argv[2];
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    logErr(`manifest okunamadi (${manifestPath}): ${err.message}`);
    process.exit(1);
    return;
  }
  const idleEnv = Number(process.env.CREWPANE_MCP_IDLE_MIN);
  if (Number.isFinite(idleEnv) && idleEnv >= 0) manifest.idleMs = idleEnv * 60 * 1000;
  const proxy = createProxy(manifest, { env: process.env, baseEnv: sanitizedBaseEnv() });

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      Promise.resolve(proxy.handle(msg))
        .then((res) => { if (res) process.stdout.write(`${JSON.stringify(res)}\n`); })
        .catch((err) => logErr(`handle: ${err.message}`));
    }
  });
  process.stdin.on('end', () => { proxy.stopAll(); process.exit(0); });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { proxy.stopAll(); process.exit(0); });
  }
  logErr(`hazir — ${proxy.services.length} servis, hicbiri baslatilmadi (ilk cagriyi bekliyor)`);
}

/**
 * Cocuklarin ortak env tabani. Vekilin KENDI env'indeki entegrasyon sirlari
 * (`CREWPANE_SECRET_*`) tabana KOYULMAZ — her cocuk yalniz kendi anahtarini,
 * kendi ADIYLA alir (Kural 2). Bu, cocugun `ps`/`env` yuzeyini de daraltir.
 */
function sanitizedBaseEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CREWPANE_SECRET_/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = { createProxy, createChild, proxiedName, cacheKey, readCache, writeCache, SERVER_NAME, DEFAULT_IDLE_MS };

if (require.main === module) main(process.argv);
