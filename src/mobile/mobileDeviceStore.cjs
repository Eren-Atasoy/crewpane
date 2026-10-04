// ADP-293 — mobil cihaz deposu + TAILNET bind çözümleyicisi.
//
// Depo: `~/.crewpane[-dev|-test]/mobile-devices.json` — sprintStore/delegationQueueStore
// deseni: MAIN tek yazar, atomik tmp+rename (yarım JSON asla görünmez), bozuk dosya asla
// fırlatmaz. Dosya 0600 (yalnız kullanıcı): içinde token HASH'leri var (token'ın kendisi yok).
//
// Bind: gateway ASLA 0.0.0.0'a bağlanmaz — bu YAPISAL kuraldır, ayar değil (ADR-020 §7).
// Sıra: (1) CREWPANE_MOBILE_BIND env (test/ileri kullanım; 0.0.0.0/:: REDDEDİLİR),
//       (2) tailnet adresi (CGNAT 100.64.0.0/10 — Tailscale'in verdiği adres),
//       (3) 127.0.0.1 (tailnet yok → uzaktan erişim YOK; app yine de çalışır).

'use strict';

const fs = require('node:fs');
// ADP-835 (790 K1) — atomik yazımın rename adımı platform boğazından geçer:
// Windows'ta Defender/Search hedefi açık tutunca EPERM/EBUSY gelir ve bu çağrıların
// çoğu best-effort catch içinde OLDUĞU İÇİN kayıt SESSİZCE kaybolurdu.
const { renameWithRetrySync } = require('../../platform/atomicWrite.cjs');
// ADP-835 (790 I3) — eşleştirme jetonlarının izin kısıtlaması tek boğazdan.
const { restrictFile } = require('../../platform/restrictPath.cjs');
const os = require('node:os');
const path = require('node:path');
const instancePaths = require('../config/instancePaths.cjs');

const STORE_VERSION = 1;
const FILE_NAME = 'mobile-devices.json';
const AUDIT_FILE = 'mobile-audit.log';
// ADP-631 — append-only log, sınırsız büyür (her müşteride, kalıcı). 5MB'de tek
// `.1` yedeğe rotate edilir (üst sınır ~10MB); cron/harici araç gerektirmez.
const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

function storePath(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), FILE_NAME);
}
function auditPath(homedir) {
  return path.join(instancePaths.crewpaneHome(homedir), AUDIT_FILE);
}

/** Her okuma bu şekli döndürür — çağıran asla undefined alanla uğraşmaz. */
function normalizeState(raw) {
  const enabled = !!(raw && raw.enabled === true);
  const devices = Array.isArray(raw && raw.devices)
    ? raw.devices.filter((d) => d && typeof d === 'object' && typeof d.tokenHash === 'string')
    : [];
  return { version: STORE_VERSION, enabled, devices };
}

function loadState(homedir) {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(storePath(homedir), 'utf8')));
  } catch {
    return normalizeState(null); // yok / bozuk → varsayılan KAPALI
  }
}

/** Atomik yazım (tmp+rename) + 0600. */
function saveState(state, homedir) {
  const file = storePath(homedir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeState(state), null, 2), { mode: 0o600 });
  renameWithRetrySync(tmp, file);
  // ADP-835 (790 I3) — `chmodSync` Windows'ta yalnız salt-okunur bayrağını
  // kıpırdatır; gizliliğe katkısı YOK, üstelik 0o600 dosyayı YAZILAMAZ yapabilir.
  // Boğaz darwin'de bugünkü chmod'u yapar, win32'de dokunmaz ve durumu SÖYLER.
  restrictFile(file);
  return file;
}

/** Dosya AUDIT_MAX_BYTES'ı aşmışsa `.1`'e taşı (var olanın üstüne yazar) ve sıfırdan başlat. */
function rotateAuditIfNeeded(file) {
  try {
    if (fs.statSync(file).size < AUDIT_MAX_BYTES) return;
  } catch {
    return; // dosya yok — rotate edilecek bir şey yok
  }
  try {
    renameWithRetrySync(file, `${file}.1`);
  } catch {
    /* best-effort — rotate başarısız olsa da append denemesi devam eder */
  }
}

/** Audit JSONL — append-only; asla fırlatmaz (log yazımı isteği bloklamaz). */
function appendAudit(line, homedir) {
  try {
    const file = auditPath(homedir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateAuditIfNeeded(file);
    fs.appendFileSync(file, line + '\n', { mode: 0o600 });
    restrictFile(file); // ADP-835 (790 I3) — win32'de durumu dürüstçe raporlar
    return file;
  } catch {
    return null;
  }
}

// ── Bind çözümleme ──────────────────────────────────────────────────────────

/** Tailscale/CGNAT adresi mi? (100.64.0.0/10) */
function isTailnetAddress(addr) {
  const m = /^100\.(\d{1,3})\./.exec(String(addr || ''));
  if (!m) return false;
  const second = Number(m[1]);
  return second >= 64 && second <= 127;
}

/** YAPISAL yasak: her-arayüz bind'i (0.0.0.0 / ::) asla kabul edilmez. */
function isForbiddenBind(addr) {
  const a = String(addr || '').trim();
  return a === '0.0.0.0' || a === '::' || a === '*' || a === '';
}

/**
 * Gateway'in dinleyeceği adres.
 * @returns {{host:string, kind:'env'|'tailnet'|'loopback', reason?:string}}
 */
function resolveBindHost({ env = process.env, interfaces = os.networkInterfaces() } = {}) {
  const wanted = env.CREWPANE_MOBILE_BIND;
  if (wanted) {
    if (isForbiddenBind(wanted)) {
      // Kural ayar tarafından DELİNEMEZ: her-arayüz bind'i sessizce loopback'e düşer.
      return { host: '127.0.0.1', kind: 'loopback', reason: `her-arayüz bind reddedildi (${wanted})` };
    }
    return { host: String(wanted), kind: 'env' };
  }
  for (const list of Object.values(interfaces || {})) {
    for (const ni of list || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal && isTailnetAddress(ni.address)) {
        return { host: ni.address, kind: 'tailnet' };
      }
    }
  }
  return { host: '127.0.0.1', kind: 'loopback', reason: 'tailnet adresi yok (Tailscale kurulu/bağlı değil)' };
}

module.exports = {
  STORE_VERSION,
  storePath,
  auditPath,
  normalizeState,
  loadState,
  saveState,
  appendAudit,
  AUDIT_MAX_BYTES,
  rotateAuditIfNeeded,
  isTailnetAddress,
  isForbiddenBind,
  resolveBindHost,
};
