// ADP-586 (Entegrasyon Merkezi / Dalga 0) — "Bağlantıyı test et" ÇEKİRDEĞİ.
//
// Kullanıcı bir anahtar girdiğinde tek gerçek soru şudur: "bu anahtarla MCP server
// AYAĞA KALKIYOR ve araç listesi veriyor mu?". ADP-588 katalog girişlerini tam olarak
// bu handshake ile doğruladı (initialize → notifications/initialized → tools/list);
// burası aynı probe'un ürün içindeki hâlidir — kullanıcı "kaydettim ama çalışıyor mu?"
// sorusunu bir pane açmadan yanıtlar.
//
// GÜVENLİK:
//   • Anahtar YALNIZ child env'ine konur — ARGV'ye ASLA (argv `ps` çıktısında görünür,
//     katalogdaki Sentry notunun gerekçesiyle aynı).
//   • `command`/`args` DAİMA katalogdan gelir (çağıranın sözleşmesi), kayıttan/
//     renderer'dan DEĞİL → keyfi ikili çalıştırma yüzeyi yok.
//   • Dönüş yalnız {ok, tools, serverName, reason, detail}; server'ın ham çıktısı
//     dışarı verilmez, `detail` çağıran tarafında maskeden geçirilir.
//
// DAYANIKLILIK: probe zaman aşımında child MUTLAKA öldürülür (SIGTERM → SIGKILL).
// `npx -y` ilk çağrıda paketi indirir; varsayılan zaman aşımı bu yüzden cömerttir.
//
// Saf + DI (`spawn` enjekte edilir) → `node --test` ağsız sahte child ile koşar.

'use strict';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_STDERR = 4000;

function jsonRpc(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/**
 * MCP stdio server'ını gerçek JSON-RPC handshake'iyle yokla.
 * @param {object} opts
 * @param {string} opts.command
 * @param {string[]} [opts.args]
 * @param {Record<string,string>} [opts.env] - child'ın TAM env'i (anahtar burada)
 * @param {string} [opts.cwd]
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.spawn] - child_process.spawn (test ikizi)
 * @returns {Promise<{ok:boolean, tools:number|null, serverName:string|null,
 *                    reason:string|null, detail:string|null, durationMs:number}>}
 */
function probeMcpServer(opts = {}) {
  const spawn = opts.spawn || require('node:child_process').spawn;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(opts.command, Array.isArray(opts.args) ? opts.args : [], {
        cwd: opts.cwd || undefined,
        env: opts.env || {},
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        ok: false, tools: null, serverName: null, reason: 'spawn-failed',
        detail: String((err && err.message) || err), durationMs: Date.now() - startedAt,
      });
      return;
    }

    let settled = false;
    let buf = '';
    let stderr = '';
    let serverName = null;
    let timer = null;

    function finish(result) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* zaten ölmüş */ }
      // Kapanmayan child'ı (npx sarmalayıcısı SIGTERM'i yutabiliyor) bırakmayız.
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ok */ } }, 2000);
      if (typeof killer.unref === 'function') killer.unref();
      resolve({ ...result, durationMs: Date.now() - startedAt });
    }

    timer = setTimeout(() => {
      finish({
        ok: false, tools: null, serverName,
        reason: 'timeout',
        detail: stderr.slice(-MAX_STDERR) || `${timeoutMs} ms içinde yanıt yok`,
      });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.on('error', (err) => {
      finish({
        ok: false, tools: null, serverName, reason: 'spawn-failed',
        detail: String((err && err.message) || err),
      });
    });

    child.on('exit', (code) => {
      // Handshake tamamlanmadan ölen server = anahtar/kurulum sorunu (stderr açıklar).
      finish({
        ok: false, tools: null, serverName, reason: 'exited',
        detail: stderr.slice(-MAX_STDERR) || `server ${code} koduyla kapandı`,
      });
    });

    if (child.stderr) {
      child.stderr.on('data', (d) => { stderr = (stderr + String(d)).slice(-MAX_STDERR); });
    }

    child.stdout.on('data', (d) => {
      buf += String(d);
      let nl;
      // MCP stdio çerçevesi: satır-ayrımlı JSON. Yarım satır tamponda bekler.
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // log gürültüsü — atla
        if (msg.id === 1) {
          if (msg.error) {
            finish({
              ok: false, tools: null, serverName, reason: 'initialize-error',
              detail: String((msg.error && msg.error.message) || 'initialize reddedildi'),
            });
            return;
          }
          serverName = (msg.result && msg.result.serverInfo && msg.result.serverInfo.name) || null;
          try {
            child.stdin.write(jsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }));
            child.stdin.write(jsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
          } catch (err) {
            finish({
              ok: false, tools: null, serverName, reason: 'io-error',
              detail: String((err && err.message) || err),
            });
          }
        } else if (msg.id === 2) {
          if (msg.error) {
            finish({
              ok: false, tools: null, serverName, reason: 'tools-error',
              detail: String((msg.error && msg.error.message) || 'tools/list reddedildi'),
            });
            return;
          }
          const tools = Array.isArray(msg.result && msg.result.tools) ? msg.result.tools.length : 0;
          finish({ ok: true, tools, serverName, reason: null, detail: null });
        }
      }
    });

    try {
      child.stdin.write(jsonRpc({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'crewpane-integration-test', version: '1' },
        },
      }));
    } catch (err) {
      finish({
        ok: false, tools: null, serverName: null, reason: 'io-error',
        detail: String((err && err.message) || err),
      });
    }
  });
}

module.exports = { probeMcpServer, PROTOCOL_VERSION, DEFAULT_TIMEOUT_MS };
